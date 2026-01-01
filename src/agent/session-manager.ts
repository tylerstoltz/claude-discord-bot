import type { BotConfig } from "../config.js";
import { SessionPersistence } from "../persistence/session-store.js";
import { AIClient } from "./ai-client.js";
import type { PermissionHook } from "./permission-hook.js";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";
import type { Logger } from "../logging/logger.js";
import type { ProcessedImage } from "../types/attachment-types.js";

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

  constructor(private config: BotConfig, private logger: Logger) {
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
        this.logger.info('💾 SESSION', `Resuming session for channel ${channelId.slice(-6)}`, `ID: ${persistedId.slice(0, 8)}`);
      } else {
        this.logger.info('💾 SESSION', `Creating new session for channel ${channelId.slice(-6)}`);
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
          this.logger.debug('💾 SESSION', `Got session ID: ${sessionId.slice(0, 8)}`);
          session.sdkSessionId = sessionId;
          this.sessionStore.setSessionId(channelId, sessionId);
          // Persist immediately
          this.sessionStore.save().catch((err) =>
            this.logger.error('💾 SESSION', 'Failed to persist', err.message)
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

    this.logger.info('💾 SESSION', `Cleared session for channel ${channelId.slice(-6)}`);
  }

  async compactSession(channelId: string): Promise<boolean> {
    const session = this.activeSessions.get(channelId);

    if (!session?.sdkSessionId) {
      return false;
    }

    // The SDK handles compaction internally
    // We just need to continue using the same session
    this.logger.info('💾 SESSION', `Compact requested for channel ${channelId.slice(-6)}`);
    return true;
  }

  async queryAndStreamWithImages(
    channelId: string,
    text: string,
    images: ProcessedImage[],
    updater: ChunkedUpdater
  ): Promise<void> {
    const session = await this.getOrCreateSession(channelId);
    session.lastActivity = new Date();

    // Build user message with text + images
    const userMessage = this.buildUserMessage(text, images);

    const aiClient = new AIClient(this.config, this.permissionHook, channelId);

    await aiClient.queryWithMessage(
      userMessage,
      updater,
      session.sdkSessionId || undefined,
      {
        onSessionInit: (sessionId) => {
          this.logger.debug('💾 SESSION', `Got session ID: ${sessionId.slice(0, 8)}`);
          session.sdkSessionId = sessionId;
          this.sessionStore.setSessionId(channelId, sessionId);
          this.sessionStore.save().catch((err) =>
            this.logger.error('💾 SESSION', 'Failed to persist', err.message)
          );
        },
      }
    );

    this.sessionStore.updateActivity(channelId);
  }

  private buildUserMessage(text: string, images: ProcessedImage[]): any {
    if (images.length === 0) {
      // Simple text-only message
      return {
        role: 'user',
        content: text
      };
    }

    // Message with text + images - use content blocks
    const content: any[] = [
      { type: 'text', text }
    ];

    for (const img of images) {
      content.push({
        type: 'image',
        source: img.source
      });
    }

    return {
      role: 'user',
      content
    };
  }
}
