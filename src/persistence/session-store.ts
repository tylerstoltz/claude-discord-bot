import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export interface SessionData {
  sdkSessionId: string;
  lastActivity: string;
  messageHistory?: string[]; // Stack of session IDs for rewind functionality
}

export interface SessionStore {
  channels: Record<string, SessionData>;
}

export class SessionPersistence {
  private filePath: string;
  private data: SessionStore;

  constructor(filePath: string) {
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
    } catch (error) {
      console.warn(`Failed to load sessions, starting fresh: ${error}`);
      this.data = { channels: {} };
    }
  }

  async save(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error(`Failed to save sessions: ${error}`);
    }
  }

  getSessionId(channelId: string): string | null {
    return this.data.channels[channelId]?.sdkSessionId || null;
  }

  setSessionId(channelId: string, sessionId: string): void {
    const existing = this.data.channels[channelId];
    this.data.channels[channelId] = {
      sdkSessionId: sessionId,
      lastActivity: new Date().toISOString(),
      messageHistory: existing?.messageHistory || [],
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

  pruneOldSessions(maxAgeDays: number): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    for (const [channelId, session] of Object.entries(this.data.channels)) {
      const lastActivity = new Date(session.lastActivity).getTime();
      if (lastActivity < cutoff) {
        delete this.data.channels[channelId];
      }
    }
  }

  pushMessageHistory(channelId: string, sessionId: string): void {
    if (!this.data.channels[channelId]) {
      return;
    }
    const history = this.data.channels[channelId].messageHistory || [];
    history.push(sessionId);
    this.data.channels[channelId].messageHistory = history;
  }

  getMessageHistory(channelId: string): string[] {
    return this.data.channels[channelId]?.messageHistory || [];
  }

  rewindMessageHistory(channelId: string, count: number): string | null {
    if (!this.data.channels[channelId]) {
      return null;
    }

    const history = this.data.channels[channelId].messageHistory || [];

    // Remove 'count' entries from the end
    for (let i = 0; i < count && history.length > 0; i++) {
      history.pop();
    }

    this.data.channels[channelId].messageHistory = history;

    // Return the new current session ID (last in history) or null
    return history.length > 0 ? history[history.length - 1] : null;
  }

  getMessageCount(channelId: string): number {
    return this.data.channels[channelId]?.messageHistory?.length || 0;
  }
}
