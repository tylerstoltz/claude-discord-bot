import type { Message, SendableChannels } from "discord.js";
import { takeChunk } from "./message-splitter.js";
import type { Logger } from "../logging/logger.js";
import type { ActivityManager } from "../bot/activity-manager.js";
import type { FileUploadManager } from "../attachments/file-upload-manager.js";

/**
 * Streams Claude's output into Discord messages.
 *
 * Edits the current message at most every `updateIntervalMs`. When the text outgrows
 * one message, the current message is finished at a natural break and a new one is
 * started, so long replies keep streaming instead of freezing at the size limit.
 */
export class ChunkedUpdater {
  private buffer = "";
  // Characters of `buffer` already posted in finished (earlier) messages
  private committed = 0;
  // Fence-reopening prefix for the current message when a split fell inside a code block
  private carry = "";
  private currentMessage: Message | null = null;
  private lastShown = "";
  private sentAny = false;

  private updateTimer: NodeJS.Timeout | null = null;
  private lastRenderTime = 0;
  // Renders run one at a time, in order
  private renderChain: Promise<void> = Promise.resolve();
  private finalized = false;

  // Claude's own text (no tool previews) — scanned for [UPLOAD: path] markers
  private assistantText = "";
  // Write tool calls awaiting their result: tool_use_id -> file_path
  private pendingWrites = new Map<string, string>();

  constructor(
    private channel: SendableChannels,
    private replyTo: Message,
    private updateIntervalMs: number = 3000,
    private maxMessageLength: number = 2000,
    private logger?: Logger,
    private activityManager?: ActivityManager,
    private fileUploadManager?: FileUploadManager
  ) {}

  appendContent(content: string): void {
    if (this.finalized) return;
    this.buffer += content;
    this.assistantText += content;
    this.logger?.streaming(this.buffer.length);
    this.activityManager?.setStatus('writing');
    this.scheduleUpdate();
  }

  /** Append bot-generated text (warnings, errors) that is not part of Claude's reply. */
  appendNotice(notice: string): void {
    if (this.finalized) return;
    this.buffer += `\n\n${notice}`;
    this.scheduleUpdate();
  }

  onToolUse(toolName: string, toolInput: unknown, toolUseId: string): void {
    if (this.finalized) return;

    let inputPreview = "";
    try {
      const inputStr = JSON.stringify(toolInput);
      inputPreview = inputStr.length > 100 ? inputStr.slice(0, 100) + "..." : inputStr;
    } catch {
      inputPreview = String(toolInput).slice(0, 100);
    }

    this.logger?.toolUse(toolName, inputPreview);
    this.activityManager?.setStatus('working');

    // Remember Write calls; the file is only uploaded once the write actually succeeds
    const filePath = (toolInput as { file_path?: unknown } | null)?.file_path;
    if (toolName === 'Write' && typeof filePath === 'string') {
      this.pendingWrites.set(toolUseId, filePath);
    }

    this.buffer += `\n\n> **Using:** \`${toolName}\`\n> ${inputPreview}\n\n`;

    // Show tool use immediately
    this.flushNow();
  }

  onToolResult(toolUseId: string, isError: boolean): void {
    const filePath = this.pendingWrites.get(toolUseId);
    if (!filePath) return;
    this.pendingWrites.delete(toolUseId);
    // Denied or failed writes return an error result — don't upload (the file may be stale)
    if (!isError) {
      this.fileUploadManager?.trackFile(filePath);
    }
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || this.finalized) {
      return;
    }

    const delay = Math.max(0, this.updateIntervalMs - (Date.now() - this.lastRenderTime));
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.enqueueRender(false);
    }, delay);
  }

  private flushNow(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.enqueueRender(false);
  }

  private enqueueRender(final: boolean): Promise<void> {
    this.renderChain = this.renderChain
      .then(() => this.render(final))
      .catch((error) => {
        this.logger?.error('✍️  STREAM', 'Render failed', (error as Error).message);
      });
    return this.renderChain;
  }

  private async render(final: boolean): Promise<void> {
    // A streaming render queued before finalize() must not run after it
    if (this.finalized && !final) return;
    this.lastRenderTime = Date.now();

    for (;;) {
      const tail = this.carry + this.buffer.slice(this.committed);
      if (tail.length <= this.maxMessageLength) {
        await this.show(tail);
        return;
      }

      // Finish the current message at a natural break and continue in a new one
      const chunk = takeChunk(tail, this.maxMessageLength);
      await this.show(chunk.text);
      this.currentMessage = null;
      this.lastShown = "";

      this.committed += chunk.consumed - this.carry.length;
      while (this.committed < this.buffer.length && /\s/.test(this.buffer[this.committed])) {
        this.committed++;
      }
      this.carry = chunk.carry;
    }
  }

  private async show(text: string): Promise<void> {
    if (!text.trim() || text === this.lastShown) return;

    try {
      if (this.currentMessage) {
        await this.currentMessage.edit(text);
      } else {
        // First message replies to the user; continuations are plain follow-ups
        this.currentMessage = this.sentAny
          ? await this.channel.send(text)
          : await this.replyTo.reply(text);
        this.sentAny = true;
      }
      this.lastShown = text;
    } catch (error) {
      // discord.js already retries rate limits; anything reaching here is a real failure
      this.logger?.error('✍️  STREAM', 'Failed to send/edit message', (error as Error).message);
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;

    // Clear streaming indicator
    this.logger?.streamingComplete();

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.finalized = true;

    // Waits for any in-flight render, then posts the complete text
    await this.enqueueRender(true);

    // Upload files written this turn, then any [UPLOAD: path] markers
    await this.uploadTrackedFiles();
    await this.parseAndUploadMarkers(this.assistantText);
  }

  /** Append an error to the reply and finalize it. */
  async fail(errorMessage: string): Promise<void> {
    this.appendNotice(`**Error:** ${errorMessage}`);
    await this.finalize();
  }

  private async parseAndUploadMarkers(content: string): Promise<void> {
    if (!this.fileUploadManager) {
      return;
    }

    // Look for upload markers: [UPLOAD: /path/to/file.png]
    const uploadMarkerRegex = /\[UPLOAD:\s*(.+?)\]/g;
    const filePaths = [...content.matchAll(uploadMarkerRegex)].map((m) => m[1].trim());

    if (filePaths.length === 0) {
      return;
    }

    const uploadedCount = await this.fileUploadManager.uploadFiles(
      this.channel,
      filePaths,
      '📎 **Here are your files:**'
    );
    if (uploadedCount > 0) {
      this.logger?.info('📤 UPLOAD', `Uploaded ${uploadedCount} file(s) via markers`);
    }
  }

  private async uploadTrackedFiles(): Promise<void> {
    if (!this.fileUploadManager) {
      return;
    }

    const uploadedCount = await this.fileUploadManager.uploadTrackedFiles(this.channel);
    if (uploadedCount > 0) {
      this.logger?.info('📤 UPLOAD', `Uploaded ${uploadedCount} file(s) to Discord`);
    }
  }
}
