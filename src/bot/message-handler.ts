import { Message, TextChannel } from "discord.js";
import type { BotConfig } from "../config.js";
import type { SessionManager } from "../agent/session-manager.js";
import { ChunkedUpdater } from "../streaming/chunked-updater.js";
import type { Logger } from "../logging/logger.js";
import type { ActivityManager } from "./activity-manager.js";

export class MessageHandler {
  private processingMessages = new Set<string>();

  constructor(
    private config: BotConfig,
    private sessionManager: SessionManager,
    private botUserId: string,
    private logger: Logger,
    private activityManager: ActivityManager
  ) {}

  async handleMessage(message: Message): Promise<void> {
    // Check if we should respond
    if (!this.shouldRespond(message)) {
      return;
    }

    // Prevent duplicate processing
    if (this.processingMessages.has(message.id)) {
      return;
    }

    this.processingMessages.add(message.id);

    try {
      // Get or create session for this channel
      const session = await this.sessionManager.getOrCreateSession(message.channelId);

      // Check if already processing another message
      if (session.isProcessing) {
        await message.react("\u23F3"); // Hourglass
        return;
      }

      session.isProcessing = true;

      // Show typing indicator
      const channel = message.channel as TextChannel;

      // Clean the message content (remove bot mentions)
      const cleanedContent = this.cleanContent(message);

      if (!cleanedContent.trim()) {
        session.isProcessing = false;
        return;
      }

      const startTime = Date.now();
      this.logger.channelActivity(message.channelId, 'RECEIVED', cleanedContent.slice(0, 100));

      // Update bot status
      this.activityManager.setStatus('thinking');

      // Create chunked updater for streaming response
      const updater = new ChunkedUpdater(
        channel,
        message,
        this.config.updateIntervalMs,
        this.config.maxMessageLength,
        this.logger,
        this.activityManager
      );

      try {
        // Start typing indicator
        await channel.sendTyping();

        // Query Claude and stream response
        await this.sessionManager.queryAndStream(
          message.channelId,
          cleanedContent,
          updater
        );

        // Finalize the response
        await updater.finalize();

        // Calculate duration and log completion
        const duration = Date.now() - startTime;
        this.logger.complete(duration);
      } catch (error) {
        this.logger.error('💬 MSG', 'Error processing message', (error as Error).message);
        await updater.sendError(`Error: ${(error as Error).message}`);
      } finally {
        session.isProcessing = false;
        this.activityManager.reset();
      }
    } finally {
      this.processingMessages.delete(message.id);
    }
  }

  private shouldRespond(message: Message): boolean {
    // Don't respond to own messages
    if (message.author.id === this.botUserId) {
      return false;
    }

    // Don't respond to bots
    if (message.author.bot) {
      return false;
    }

    // Check allowed channels
    if (this.config.allowedChannels.length > 0) {
      if (!this.config.allowedChannels.includes(message.channelId)) {
        return false;
      }
    }

    // Check if mentioned
    if (this.config.monitorMentions) {
      const mentioned = message.mentions.users.has(this.botUserId);
      if (mentioned) {
        return true;
      }
    }

    // Check if monitoring all messages
    if (this.config.monitorAllMessages) {
      return true;
    }

    return false;
  }

  private cleanContent(message: Message): string {
    let content = message.content;

    // Remove bot mentions
    const mentionPatterns = [
      new RegExp(`<@!?${this.botUserId}>`, "g"),
    ];

    for (const pattern of mentionPatterns) {
      content = content.replace(pattern, "");
    }

    return content.trim();
  }
}
