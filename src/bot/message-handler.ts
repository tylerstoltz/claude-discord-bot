import type { Message } from "discord.js";
import { isChannelAllowed, isUserAllowed, type BotConfig } from "../config.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { QueryResult } from "../agent/ai-client.js";
import { ChunkedUpdater } from "../streaming/chunked-updater.js";
import type { Logger } from "../logging/logger.js";
import type { ActivityManager } from "./activity-manager.js";
import { ImageProcessor } from "../attachments/image-processor.js";
import { FileUploadManager } from "../attachments/file-upload-manager.js";

const QUEUED_EMOJI = "⏳"; // Hourglass

/** User-facing note for a query that ended without success. */
export function describeFailure(result: QueryResult): string {
  switch (result.subtype) {
    case "error_max_turns":
      return "⚠️ *Stopped: hit the turn limit for one message. Reply \"continue\" to keep going.*";
    case "error_max_budget_usd":
      return "⚠️ *Stopped: hit the cost budget for one message.*";
    default: {
      const detail = result.errors.filter(Boolean).join("; ");
      return `⚠️ *The query ended with an error${detail ? `: ${detail}` : "."}*`;
    }
  }
}

export class MessageHandler {
  private imageProcessor: ImageProcessor;

  constructor(
    private config: BotConfig,
    private sessionManager: SessionManager,
    private botUserId: string,
    private logger: Logger,
    private activityManager: ActivityManager
  ) {
    this.imageProcessor = new ImageProcessor(config.attachments, logger);
  }

  async handleMessage(message: Message): Promise<void> {
    if (!this.shouldRespond(message)) {
      return;
    }

    // Clean the message content (remove bot mentions)
    const text = this.cleanContent(message);
    const hasImages = message.attachments.some((a) => !!a.contentType?.startsWith("image/"));
    if (!text && !hasImages) {
      return;
    }

    // Busy channel: queue the message (up to maxQueuedMessages) instead of dropping it
    const session = this.sessionManager.getOrCreateSession(message.channelId);
    const busy = session.isProcessing || session.queued > 0;
    if (busy) {
      if (session.queued >= this.config.maxQueuedMessages) {
        await message.reply("I'm busy and my queue for this channel is full. Please try again shortly.");
        return;
      }
      await message.react(QUEUED_EMOJI).catch(() => {});
      this.logger.channelActivity(message.channelId, 'QUEUED', `${session.queued + 1} waiting`);
    }

    await this.sessionManager.runExclusive(message.channelId, async () => {
      if (busy) {
        message.reactions.cache.get(QUEUED_EMOJI)?.users.remove(this.botUserId).catch(() => {});
      }
      await this.respond(message, text);
    });
  }

  private async respond(message: Message, text: string): Promise<void> {
    const channel = message.channel;
    if (!channel.isSendable()) {
      return;
    }

    const startTime = Date.now();
    this.logger.channelActivity(message.channelId, 'RECEIVED', text.slice(0, 100));

    // Process image attachments
    const images = await this.imageProcessor.processImages(
      Array.from(message.attachments.values())
    );

    if (images.length > 0) {
      this.logger.info('🖼️  IMAGES', `Processing ${images.length} image(s)`);
    } else if (!text) {
      return; // image-only message whose images were all rejected
    }

    this.activityManager.begin();

    // One upload manager per reply, so files written here are only posted here
    const updater = new ChunkedUpdater(
      channel,
      message,
      this.config.updateIntervalMs,
      this.config.maxMessageLength,
      this.logger,
      this.activityManager,
      new FileUploadManager(this.config.fileUpload, this.logger)
    );

    try {
      await channel.sendTyping().catch(() => {});

      const { result, aborted } = await this.sessionManager.queryAndStream(
        message.channelId,
        text,
        images,
        updater
      );

      if (aborted) {
        this.logger.info('💬 MSG', 'Query aborted (session cleared or rewound)');
        updater.appendNotice("⏹️ *Stopped.*");
      } else if (result && !result.success) {
        updater.appendNotice(describeFailure(result));
      }

      await updater.finalize();
      this.logger.complete(Date.now() - startTime, result?.costUsd);
    } catch (error) {
      this.logger.error('💬 MSG', 'Error processing message', (error as Error).message);
      await updater.fail((error as Error).message);
    } finally {
      this.activityManager.end();
    }
  }

  private shouldRespond(message: Message): boolean {
    // Don't respond to own messages or other bots
    if (message.author.id === this.botUserId || message.author.bot) {
      return false;
    }

    if (!isUserAllowed(this.config, message.author.id)) {
      return false;
    }

    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    if (!isChannelAllowed(this.config, message.channelId, parentId)) {
      return false;
    }

    // Check if mentioned
    if (this.config.monitorMentions && message.mentions.users.has(this.botUserId)) {
      return true;
    }

    // Check if monitoring all messages
    return this.config.monitorAllMessages;
  }

  private cleanContent(message: Message): string {
    // Remove bot mentions
    return message.content.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
  }
}
