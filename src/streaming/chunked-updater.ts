import { Message, TextChannel } from "discord.js";
import { splitMessage, formatStreamingMessage } from "./message-splitter.js";

export class ChunkedUpdater {
  private currentMessage: Message | null = null;
  private contentBuffer: string = "";
  private lastUpdateTime: number = 0;
  private updateTimer: NodeJS.Timeout | null = null;
  private isEditing: boolean = false;
  private pendingUpdate: boolean = false;
  private rateLimitBackoffMs: number = 1000;
  private consecutiveRateLimits: number = 0;

  constructor(
    private channel: TextChannel,
    private replyTo: Message,
    private updateIntervalMs: number = 3000,
    private maxMessageLength: number = 2000
  ) {}

  appendContent(content: string): void {
    this.contentBuffer += content;
    this.scheduleUpdate();
  }

  onToolUse(toolName: string, toolInput: unknown): void {
    // Add tool indicator
    let inputPreview = "";
    try {
      const inputStr = JSON.stringify(toolInput);
      inputPreview = inputStr.length > 100 ? inputStr.slice(0, 100) + "..." : inputStr;
    } catch {
      inputPreview = String(toolInput).slice(0, 100);
    }

    this.contentBuffer += `\n\n> **Using:** \`${toolName}\`\n> ${inputPreview}\n\n`;

    // Force immediate update on tool use
    this.flushUpdate();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) {
      return;
    }

    const timeSinceLastUpdate = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, this.updateIntervalMs - timeSinceLastUpdate);

    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.flushUpdate();
    }, delay);
  }

  async flushUpdate(): Promise<void> {
    if (!this.contentBuffer || this.isEditing) {
      this.pendingUpdate = true;
      return;
    }

    const contentToSend = this.contentBuffer;
    this.isEditing = true;
    this.pendingUpdate = false;

    try {
      if (!this.currentMessage) {
        // First message - send as reply
        const formatted = formatStreamingMessage(
          contentToSend,
          this.maxMessageLength,
          false
        );
        this.currentMessage = await this.replyTo.reply(formatted);
      } else {
        // Edit existing message
        const formatted = formatStreamingMessage(
          contentToSend,
          this.maxMessageLength,
          false
        );
        await this.currentMessage.edit(formatted);
      }

      this.lastUpdateTime = Date.now();
      this.consecutiveRateLimits = 0;
    } catch (error: any) {
      // Handle rate limits
      if (
        error.code === 50013 ||
        error.message?.includes("rate limit") ||
        error.httpStatus === 429
      ) {
        this.consecutiveRateLimits++;
        const backoff = this.rateLimitBackoffMs * Math.pow(2, this.consecutiveRateLimits - 1);

        console.warn(`[STREAM] Rate limited, backing off ${backoff}ms`);

        await this.sleep(backoff);
        this.pendingUpdate = true;
      } else {
        console.error("[STREAM] Error updating message:", error);
      }
    } finally {
      this.isEditing = false;

      // Process pending update if any
      if (this.pendingUpdate && this.contentBuffer) {
        this.scheduleUpdate();
      }
    }
  }

  async finalize(): Promise<void> {
    // Clear any pending timer
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Wait for any in-progress edit
    while (this.isEditing) {
      await this.sleep(100);
    }

    // Send final content
    if (!this.contentBuffer) {
      return;
    }

    const finalContent = this.contentBuffer;

    // Check if content fits in one message
    if (finalContent.length <= this.maxMessageLength) {
      if (this.currentMessage) {
        try {
          await this.currentMessage.edit(finalContent);
        } catch (error) {
          console.error("[STREAM] Failed to edit final message:", error);
        }
      } else {
        try {
          await this.replyTo.reply(finalContent);
        } catch (error) {
          console.error("[STREAM] Failed to send final message:", error);
        }
      }
    } else {
      // Split into multiple messages
      const chunks = splitMessage(finalContent, this.maxMessageLength);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
          if (i === 0 && this.currentMessage) {
            // Edit first message
            await this.currentMessage.edit(chunk);
          } else if (i === 0) {
            // Send first as reply
            await this.replyTo.reply(chunk);
          } else {
            // Send rest as follow-ups
            await this.channel.send(chunk);
          }
        } catch (error) {
          console.error(`[STREAM] Failed to send chunk ${i}:`, error);
        }

        // Small delay between messages to avoid rate limits
        if (i < chunks.length - 1) {
          await this.sleep(500);
        }
      }
    }
  }

  async sendError(errorMessage: string): Promise<void> {
    const formatted = `**Error:** ${errorMessage}`;

    try {
      if (this.currentMessage) {
        const content = this.contentBuffer
          ? this.contentBuffer + "\n\n" + formatted
          : formatted;
        await this.currentMessage.edit(content.slice(0, this.maxMessageLength));
      } else {
        await this.replyTo.reply(formatted);
      }
    } catch (error) {
      console.error("[STREAM] Failed to send error message:", error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
