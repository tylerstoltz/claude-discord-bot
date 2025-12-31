import type { BotConfig } from "../config.js";
import { SessionPersistence } from "../persistence/session-store.js";
import { AIClient } from "./ai-client.js";
import type { PermissionHook } from "./permission-hook.js";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";

export interface ManagedSession {
  channelId: string;
  sdkSessionId: string | null;
  isProcessing: boolean;
  lastActivity: Date;
}

export class SessionManager {
  private activeSessions = new Map<string, ManagedSession>();
  private sessionStore: SessionPersistence;
  private permissionHook: PermissionHook | null = null;

  constructor(private config: BotConfig) {
    this.sessionStore = new SessionPersistence(config.sessionPersistPath);
  }

  setPermissionHook(hook: PermissionHook): void {
    this.permissionHook = hook;
  }

  async loadPersistedSessions(): Promise<void> {
    await this.sessionStore.load();

    // Pre-populate active sessions from persisted data
    for (const channelId of this.sessionStore.getAllChannels()) {
      const sessionId = this.sessionStore.getSessionId(channelId);
      if (sessionId) {
        this.activeSessions.set(channelId, {
          channelId,
          sdkSessionId: sessionId,
          isProcessing: false,
          lastActivity: new Date(),
        });
        console.log(`[SESSION] Loaded persisted session for channel ${channelId}`);
      }
    }
  }

  async persistSessions(): Promise<void> {
    await this.sessionStore.save();
  }

  getActiveSession(channelId: string): ManagedSession | undefined {
    return this.activeSessions.get(channelId);
  }

  async getOrCreateSession(channelId: string): Promise<ManagedSession> {
    let session = this.activeSessions.get(channelId);

    if (!session) {
      // Check for persisted session
      const persistedId = this.sessionStore.getSessionId(channelId);

      session = {
        channelId,
        sdkSessionId: persistedId,
        isProcessing: false,
        lastActivity: new Date(),
      };

      this.activeSessions.set(channelId, session);

      if (persistedId) {
        console.log(`[SESSION] Resuming session ${persistedId} for channel ${channelId}`);
      } else {
        console.log(`[SESSION] Creating new session for channel ${channelId}`);
      }
    }

    return session;
  }

  async queryAndStream(
    channelId: string,
    prompt: string,
    updater: ChunkedUpdater
  ): Promise<void> {
    const session = await this.getOrCreateSession(channelId);
    session.lastActivity = new Date();

    const aiClient = new AIClient(this.config, this.permissionHook, channelId);

    const newSessionId = await aiClient.queryWithUpdater(
      prompt,
      updater,
      session.sdkSessionId || undefined,
      {
        onSessionInit: (sessionId) => {
          console.log(`[SESSION] Got session ID: ${sessionId}`);
          session.sdkSessionId = sessionId;
          this.sessionStore.setSessionId(channelId, sessionId);
          // Persist immediately
          this.sessionStore.save().catch((err) =>
            console.error("[SESSION] Failed to persist:", err)
          );
        },
      }
    );

    // Update session ID if we got a new one
    if (newSessionId && newSessionId !== session.sdkSessionId) {
      session.sdkSessionId = newSessionId;
      this.sessionStore.setSessionId(channelId, newSessionId);
      await this.sessionStore.save();
    }

    this.sessionStore.updateActivity(channelId);
  }

  async clearSession(channelId: string): Promise<void> {
    const session = this.activeSessions.get(channelId);

    if (session) {
      session.sdkSessionId = null;
      session.isProcessing = false;
      session.lastActivity = new Date();
    }

    this.sessionStore.clearSession(channelId);
    await this.sessionStore.save();

    console.log(`[SESSION] Cleared session for channel ${channelId}`);
  }

  async compactSession(channelId: string): Promise<boolean> {
    const session = this.activeSessions.get(channelId);

    if (!session?.sdkSessionId) {
      return false;
    }

    // The SDK handles compaction internally
    // We just need to continue using the same session
    console.log(`[SESSION] Compact requested for channel ${channelId}`);
    return true;
  }
}
