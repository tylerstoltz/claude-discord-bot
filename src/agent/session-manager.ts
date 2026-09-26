import type { BotConfig } from "../config.js";
import { SessionPersistence } from "../persistence/session-store.js";
import { AIClient, SessionNotFoundError, type QueryHandlers, type QueryResult, type UserMessageParam } from "./ai-client.js";
import type { PermissionHook } from "./permission-hook.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";
import type { Logger } from "../logging/logger.js";
import type { ProcessedImage } from "../types/attachment-types.js";
import { readdir, rm, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ManagedSession {
  channelId: string;
  sdkSessionId: string | null;
  isProcessing: boolean;
  lastActivity: Date;
  abortController: AbortController | null;
  // Tail of the per-channel work queue; each task chains onto it
  queueTail: Promise<void>;
  // Tasks waiting behind the running one
  queued: number;
  // The running task, so /clear and /rewind can wait for it to settle after aborting
  current: Promise<unknown> | null;
  // Held by /clear and /rewind while they abort and change the session; queued tasks wait on it
  barrier: Promise<void>;
}

/** Directory Claude Code stores transcripts in: ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects). */
function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Claude Code names a project's transcript dir after its cwd with every non-alphanumeric char replaced by '-'. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class SessionManager {
  private activeSessions = new Map<string, ManagedSession>();
  private sessionStore: SessionPersistence;
  private permissionHook: PermissionHook | null = null;
  private discordMcpServer: McpSdkServerConfigWithInstance | null = null;

  constructor(private config: BotConfig, private logger: Logger) {
    this.sessionStore = new SessionPersistence(config.sessionPersistPath, logger);
  }

  setPermissionHook(hook: PermissionHook): void {
    this.permissionHook = hook;
  }

  setDiscordMcpServer(server: McpSdkServerConfigWithInstance): void {
    this.discordMcpServer = server;
  }

  async loadPersistedSessions(): Promise<void> {
    await this.sessionStore.load();

    // Pre-populate active sessions from persisted data
    for (const channelId of this.sessionStore.getAllChannels()) {
      if (this.sessionStore.getSessionId(channelId)) {
        this.getOrCreateSession(channelId);
        this.logger.debug('💾 SESSION', `Loaded persisted session for channel ${channelId}`);
      }
    }
  }

  async persistSessions(): Promise<void> {
    await this.sessionStore.save();
  }

  getActiveSession(channelId: string): ManagedSession | undefined {
    return this.activeSessions.get(channelId);
  }

  getTurnCount(channelId: string): number {
    return this.sessionStore.getTurnCount(channelId);
  }

  hasPendingRewind(channelId: string): boolean {
    return !!this.sessionStore.getResumeAt(channelId);
  }

  getOrCreateSession(channelId: string): ManagedSession {
    let session = this.activeSessions.get(channelId);

    if (!session) {
      // Check for persisted session
      const persistedId = this.sessionStore.getSessionId(channelId);

      session = {
        channelId,
        sdkSessionId: persistedId,
        isProcessing: false,
        lastActivity: new Date(),
        abortController: null,
        queueTail: Promise.resolve(),
        queued: 0,
        current: null,
        barrier: Promise.resolve(),
      };

      this.activeSessions.set(channelId, session);

      if (persistedId) {
        this.logger.info('💾 SESSION', `Resuming session for channel ${channelId.slice(-6)}`, `ID: ${persistedId.slice(0, 8)}`);
      } else {
        this.logger.info('💾 SESSION', `Creating new session for channel ${channelId.slice(-6)}`);
      }
    }

    return session;
  }

  /**
   * Run `task` after every earlier task for this channel has finished.
   * Tasks run one at a time per channel; different channels run concurrently.
   */
  async runExclusive<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const session = this.getOrCreateSession(channelId);
    const previous = session.queueTail;
    let release!: () => void;
    session.queueTail = new Promise<void>((resolve) => (release = resolve));

    session.queued++;
    try {
      await previous;
      // Let any /clear or /rewind in progress finish first (barriers can be re-armed while we wait)
      for (let barrier = session.barrier; ; barrier = session.barrier) {
        await barrier;
        if (barrier === session.barrier) break;
      }
    } finally {
      session.queued--;
    }

    session.isProcessing = true;
    const running = task();
    session.current = running;
    try {
      return await running;
    } finally {
      session.current = null;
      session.isProcessing = false;
      release();
    }
  }

  /**
   * Abort the running query (if any), wait for it to unwind, then run `change`
   * before any queued task can start.
   */
  private async interrupt<T>(session: ManagedSession, change: () => Promise<T>): Promise<T> {
    let lift!: () => void;
    const mine = new Promise<void>((resolve) => (lift = resolve));
    const before = session.barrier;
    session.barrier = before.then(() => mine);

    try {
      await before;
      session.abortController?.abort();
      session.abortController = null;
      await session.current?.catch(() => {});
      return await change();
    } finally {
      lift();
    }
  }

  /** Send a user message (text and/or images) to Claude and stream the reply. Call inside runExclusive. */
  async queryAndStream(
    channelId: string,
    text: string,
    images: ProcessedImage[],
    updater: ChunkedUpdater
  ): Promise<{ result: QueryResult | null; aborted: boolean }> {
    const session = this.getOrCreateSession(channelId);
    session.lastActivity = new Date();

    const abortController = new AbortController();
    session.abortController = abortController;

    const aiClient = new AIClient(this.config, this.permissionHook, channelId, this.logger, this.discordMcpServer);
    let result: QueryResult | null = null;
    // Whether anything reached Discord yet; a stale-session retry is only safe before that
    let streamed = false;

    const handlers: QueryHandlers = {
      onSessionInit: (sessionId) => {
        this.logger.debug('💾 SESSION', `Got session ID: ${sessionId.slice(0, 8)}`);
        session.sdkSessionId = sessionId;
        this.sessionStore.setSessionId(channelId, sessionId);
        this.sessionStore.save().catch(() => {});
      },
      onText: (t) => {
        streamed = true;
        updater.appendContent(t);
      },
      onToolUse: (name, input, id) => {
        streamed = true;
        updater.onToolUse(name, input, id);
      },
      onToolResult: (id, isError) => updater.onToolResult(id, isError),
      onResult: (r) => {
        result = r;
      },
    };

    const prompt = this.buildUserMessage(text, images);

    try {
      let outcome;
      try {
        outcome = await aiClient.run(
          {
            prompt,
            resume: session.sdkSessionId || undefined,
            resumeAt: this.sessionStore.getResumeAt(channelId),
            abortController,
          },
          handlers
        );
      } catch (error) {
        if (!(error instanceof SessionNotFoundError) || streamed) throw error;
        await this.discardStaleSession(channelId, session, error.sessionId);
        result = null;
        // Retry once as a brand new conversation
        outcome = await aiClient.run({ prompt, abortController }, handlers);
      }

      // Record the turn boundary (even for aborted turns, so /rewind 1 drops a partial turn)
      if (outcome.lastEntryUuid && session.sdkSessionId) {
        this.sessionStore.recordTurn(channelId, outcome.lastEntryUuid);
      }
      this.sessionStore.updateActivity(channelId);
      await this.sessionStore.save();
      return { result, aborted: outcome.aborted };
    } finally {
      // Clear abort controller only if it's still the one we created
      if (session.abortController === abortController) {
        session.abortController = null;
      }
      this.permissionHook?.cancelPendingApprovals(channelId);
    }
  }

  /** Run the SDK's /compact on the channel's session. Call inside runExclusive. */
  async compactSession(channelId: string): Promise<{ compacted: boolean; preTokens?: number; postTokens?: number; error?: string }> {
    const session = this.getOrCreateSession(channelId);
    if (!session.sdkSessionId) {
      return { compacted: false, error: "No active session to compact." };
    }

    const abortController = new AbortController();
    session.abortController = abortController;
    const aiClient = new AIClient(this.config, null, channelId, this.logger);
    let preTokens: number | undefined;
    let postTokens: number | undefined;
    let result: QueryResult | null = null;

    try {
      await aiClient.run(
        {
          prompt: "/compact",
          resume: session.sdkSessionId,
          resumeAt: this.sessionStore.getResumeAt(channelId),
          abortController,
        },
        {
          onCompact: (pre, post) => {
            preTokens = pre;
            postTokens = post;
          },
          onResult: (r) => {
            result = r;
          },
        }
      );
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      await this.discardStaleSession(channelId, session, error.sessionId);
      return { compacted: false, error: "The saved session no longer exists; the next message starts a new conversation." };
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null;
      }
    }

    if (preTokens === undefined) {
      const errors = (result as QueryResult | null)?.errors.join("; ");
      return { compacted: false, error: errors || "The SDK did not report a compaction." };
    }

    // Pre-compaction turn UUIDs are not safe rewind points any more
    this.sessionStore.clearTurns(channelId);
    await this.sessionStore.save();
    this.logger.info('💾 SESSION', `Compacted channel ${channelId.slice(-6)}`, `${preTokens} → ${postTokens ?? '?'} tokens`);
    return { compacted: true, preTokens, postTokens };
  }

  /**
   * Forget a session whose transcript Claude Code can no longer find (pruned,
   * deleted, or created on another machine), so the channel stops failing on it.
   */
  private async discardStaleSession(channelId: string, session: ManagedSession, staleId: string): Promise<void> {
    this.logger.warn('💾 SESSION', `Stale session for channel ${channelId.slice(-6)}, starting fresh`, staleId.slice(0, 8));
    session.sdkSessionId = null;
    this.sessionStore.clearSession(channelId);
    await this.sessionStore.save();
  }

  async clearSession(channelId: string): Promise<void> {
    const session = this.getOrCreateSession(channelId);

    // Stop any in-flight query and tear down the session before queued messages run
    await this.interrupt(session, async () => {
      const sessionId = session.sdkSessionId ?? this.sessionStore.getSessionId(channelId);
      if (sessionId) {
        await this.deleteSdkSessionFiles(sessionId);
      }

      session.sdkSessionId = null;
      session.lastActivity = new Date();
      this.sessionStore.clearSession(channelId);
      await this.sessionStore.save();
    });

    this.logger.info('💾 SESSION', `Cleared session for channel ${channelId.slice(-6)}`);
  }

  /** Delete the SDK transcript (<id>.jsonl) and its subagent dir (<id>/). */
  private async deleteSdkSessionFiles(sessionId: string): Promise<void> {
    const root = projectsDir();
    let projectDirs = [join(root, projectDirName(process.cwd()))];

    try {
      await unlink(join(projectDirs[0], `${sessionId}.jsonl`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('🗑️  DELETE', 'Failed to delete session file', (error as Error).message);
        return;
      }
      // Not where expected (e.g. very long cwd gets a hashed name) — search all projects
      try {
        const entries = await readdir(root);
        projectDirs = entries.map((e) => join(root, e));
      } catch {
        projectDirs = [];
      }
      let found = false;
      for (const dir of projectDirs) {
        try {
          await unlink(join(dir, `${sessionId}.jsonl`));
          projectDirs = [dir];
          found = true;
          break;
        } catch {
          // keep looking
        }
      }
      if (!found) {
        this.logger.debug('🗑️  DELETE', 'No SDK session file found', sessionId.slice(0, 8));
        return;
      }
    }

    await rm(join(projectDirs[0], sessionId), { recursive: true, force: true }).catch(() => {});
    this.logger.info('🗑️  DELETE', 'Deleted SDK session file', sessionId.slice(0, 8));
  }

  async rewindSession(channelId: string, count: number = 1): Promise<{ success: boolean; removed: number; remaining: number }> {
    const session = this.getOrCreateSession(channelId);

    // Stop any in-flight query (its partial turn is recorded) and rewind before queued messages run
    return this.interrupt(session, async () => {
      if (!session.sdkSessionId) {
        return { success: false, removed: 0, remaining: 0 };
      }

      const { removed, remaining } = this.sessionStore.rewind(channelId, count);

      if (removed > 0 && remaining === 0) {
        // Rewound past the first turn — start a fresh conversation
        session.sdkSessionId = null;
        this.sessionStore.clearSession(channelId);
      }
      await this.sessionStore.save();

      this.logger.info('⏪ REWIND', `Rewound channel ${channelId.slice(-6)}`, `${removed} turn(s) removed, ${remaining} remain`);
      return { success: true, removed, remaining };
    });
  }

  private buildUserMessage(text: string, images: ProcessedImage[]): UserMessageParam {
    if (images.length === 0) {
      return { role: 'user', content: text };
    }

    // Text block only if there is text: the API rejects empty text blocks
    const content: Exclude<UserMessageParam['content'], string> = [];
    if (text) {
      content.push({ type: 'text', text });
    }
    for (const img of images) {
      content.push({ type: 'image', source: img.source });
    }

    return { role: 'user', content };
  }
}
