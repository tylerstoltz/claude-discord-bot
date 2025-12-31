import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export interface SessionData {
  sdkSessionId: string;
  lastActivity: string;
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
    this.data.channels[channelId] = {
      sdkSessionId: sessionId,
      lastActivity: new Date().toISOString(),
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
}
