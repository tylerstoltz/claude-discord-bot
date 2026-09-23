import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname, resolve } from "path";
import type { Logger } from "../logging/logger.js";

// Cap on remembered turn boundaries per channel (bounds /rewind depth and file size)
const MAX_TURNS = 200;

export interface SessionData {
  sdkSessionId: string;
  lastActivity: string;
  // UUID of the last transcript entry of each completed turn, oldest first.
  // /rewind resumes the SDK session at one of these via `resumeSessionAt`.
  turns?: string[];
  // Set by /rewind: the next query resumes at this UUID, then it is cleared.
  resumeAt?: string;
}

export interface SessionStore {
  channels: Record<string, SessionData>;
}

export class SessionPersistence {
  private filePath: string;
  private data: SessionStore;

  constructor(filePath: string, private logger?: Logger) {
    this.filePath = resolve(filePath);
    this.data = { channels: {} };
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.data = { channels: {} };
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      this.data = JSON.parse(content);
      // Drop the legacy `messageHistory` field: it held repeated session IDs,
      // not turn boundaries, so it can't be used for rewind.
      for (const session of Object.values(this.data.channels)) {
        delete (session as { messageHistory?: unknown }).messageHistory;
      }
    } catch (error) {
      this.logger?.warn('💾 SESSION', 'Failed to load sessions, starting fresh', String(error));
      this.data = { channels: {} };
    }
  }

  async save(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Write-then-rename so a crash mid-write can't corrupt the store
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      this.logger?.error('💾 SESSION', 'Failed to save sessions', String(error));
    }
  }

  getSessionId(channelId: string): string | null {
    return this.data.channels[channelId]?.sdkSessionId || null;
  }

  /** Set the channel's SDK session. Turn history is kept only if the session is unchanged. */
  setSessionId(channelId: string, sessionId: string): void {
    const existing = this.data.channels[channelId];
    const sameSession = existing?.sdkSessionId === sessionId;
    this.data.channels[channelId] = {
      sdkSessionId: sessionId,
      lastActivity: new Date().toISOString(),
      turns: sameSession ? existing.turns || [] : [],
      resumeAt: sameSession ? existing.resumeAt : undefined,
    };
  }

  updateActivity(channelId: string): void {
    if (this.data.channels[channelId]) {
      this.data.channels[channelId].lastActivity = new Date().toISOString();
    }
  }

  clearSession(channelId: string): void {
    delete this.data.channels[channelId];
  }

  getAllChannels(): string[] {
    return Object.keys(this.data.channels);
  }

  /** Record the end of a turn. Also consumes any pending rewind point. */
  recordTurn(channelId: string, lastEntryUuid: string): void {
    const session = this.data.channels[channelId];
    if (!session) return;
    const turns = session.turns || [];
    turns.push(lastEntryUuid);
    session.turns = turns.slice(-MAX_TURNS);
    delete session.resumeAt;
  }

  /** Forget turn boundaries (after compaction the old UUIDs are no longer a safe fork point). */
  clearTurns(channelId: string): void {
    const session = this.data.channels[channelId];
    if (!session) return;
    session.turns = [];
    delete session.resumeAt;
  }

  getTurnCount(channelId: string): number {
    return this.data.channels[channelId]?.turns?.length || 0;
  }

  getResumeAt(channelId: string): string | undefined {
    return this.data.channels[channelId]?.resumeAt;
  }

  /**
   * Drop the last `count` turns. Returns how many were removed and how many remain.
   * When turns remain, the next query resumes at the new last turn.
   */
  rewind(channelId: string, count: number): { removed: number; remaining: number } {
    const session = this.data.channels[channelId];
    const turns = session?.turns || [];
    if (!session || turns.length === 0) {
      return { removed: 0, remaining: 0 };
    }

    const removed = Math.min(count, turns.length);
    session.turns = turns.slice(0, turns.length - removed);
    session.resumeAt = session.turns[session.turns.length - 1];
    return { removed, remaining: session.turns.length };
  }
}
