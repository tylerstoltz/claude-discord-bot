import { TextChannel, AttachmentBuilder } from 'discord.js';
import { stat, readFile } from 'fs/promises';
import { basename, extname, resolve } from 'path';
import type { Logger } from '../logging/logger.js';

export interface FileUploadConfig {
  enabled: boolean;
  autoUpload: boolean;
  maxFileSize: number;
  allowedExtensions: string[];
}

export class FileUploadManager {
  private trackedFiles: Set<string> = new Set();

  constructor(
    private config: FileUploadConfig,
    private logger: Logger
  ) {}

  /**
   * Track a file written by Claude's Write tool
   */
  trackFile(filePath: string): void {
    if (!this.config.enabled) {
      return;
    }

    // Resolve to absolute path
    const absolutePath = resolve(process.cwd(), filePath);
    this.trackedFiles.add(absolutePath);

    this.logger.debug('📤 UPLOAD', `Tracking file: ${basename(absolutePath)}`);
  }

  /**
   * Validate if a file should be uploaded
   */
  private async validateFile(filePath: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      // Check if file exists
      const stats = await stat(filePath);

      if (!stats.isFile()) {
        return { valid: false, reason: 'Not a file' };
      }

      // Check file size
      if (stats.size > this.config.maxFileSize) {
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        const maxMB = (this.config.maxFileSize / (1024 * 1024)).toFixed(2);
        return { valid: false, reason: `Too large (${sizeMB}MB > ${maxMB}MB)` };
      }

      // Check extension
      const ext = extname(filePath).toLowerCase();
      if (this.config.allowedExtensions.length > 0) {
        if (!this.config.allowedExtensions.includes(ext)) {
          return { valid: false, reason: `Extension ${ext} not allowed` };
        }
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, reason: (error as Error).message };
    }
  }

  /**
   * Upload all tracked files to Discord channel
   */
  async uploadTrackedFiles(channel: TextChannel): Promise<number> {
    if (!this.config.enabled || !this.config.autoUpload) {
      this.trackedFiles.clear();
      return 0;
    }

    if (this.trackedFiles.size === 0) {
      return 0;
    }

    const filesToUpload: string[] = [];

    // Validate all files first
    for (const filePath of this.trackedFiles) {
      const validation = await this.validateFile(filePath);

      if (validation.valid) {
        filesToUpload.push(filePath);
      } else {
        this.logger.warn('📤 UPLOAD', `Skipping ${basename(filePath)}`, validation.reason || 'unknown');
      }
    }

    // Clear tracked files
    this.trackedFiles.clear();

    if (filesToUpload.length === 0) {
      return 0;
    }

    // Create attachments
    const attachments: AttachmentBuilder[] = [];

    for (const filePath of filesToUpload) {
      try {
        const fileBuffer = await readFile(filePath);
        const fileName = basename(filePath);

        const attachment = new AttachmentBuilder(fileBuffer, {
          name: fileName
        });

        attachments.push(attachment);
        this.logger.info('📤 UPLOAD', `Prepared ${fileName}`, `${fileBuffer.length} bytes`);
      } catch (error) {
        this.logger.error('📤 UPLOAD', `Failed to read ${basename(filePath)}`, (error as Error).message);
      }
    }

    if (attachments.length === 0) {
      return 0;
    }

    // Upload to Discord
    try {
      await channel.send({
        content: '📎 **Files created:**',
        files: attachments
      });

      this.logger.info('📤 UPLOAD', `Uploaded ${attachments.length} file(s)`);
      return attachments.length;
    } catch (error) {
      this.logger.error('📤 UPLOAD', 'Failed to upload files', (error as Error).message);
      return 0;
    }
  }

  /**
   * Manually upload specific files by path (for user-requested uploads)
   */
  async uploadFiles(channel: TextChannel, filePaths: string[], customMessage?: string): Promise<number> {
    if (!this.config.enabled) {
      this.logger.warn('📤 UPLOAD', 'File upload is disabled in config');
      return 0;
    }

    if (filePaths.length === 0) {
      return 0;
    }

    const attachments: AttachmentBuilder[] = [];

    for (const filePath of filePaths) {
      const validation = await this.validateFile(filePath);

      if (!validation.valid) {
        this.logger.warn('📤 UPLOAD', `Skipping ${basename(filePath)}`, validation.reason || 'unknown');
        continue;
      }

      try {
        const fileBuffer = await readFile(filePath);
        const fileName = basename(filePath);

        const attachment = new AttachmentBuilder(fileBuffer, {
          name: fileName
        });

        attachments.push(attachment);
        this.logger.info('📤 UPLOAD', `Prepared ${fileName}`, `${fileBuffer.length} bytes`);
      } catch (error) {
        this.logger.error('📤 UPLOAD', `Failed to read ${basename(filePath)}`, (error as Error).message);
      }
    }

    if (attachments.length === 0) {
      this.logger.warn('📤 UPLOAD', 'No valid files to upload');
      return 0;
    }

    // Upload to Discord
    try {
      await channel.send({
        content: customMessage || '📎 **Files uploaded:**',
        files: attachments
      });

      this.logger.info('📤 UPLOAD', `Uploaded ${attachments.length} file(s)`);
      return attachments.length;
    } catch (error) {
      this.logger.error('📤 UPLOAD', 'Failed to upload files', (error as Error).message);
      return 0;
    }
  }

  /**
   * Clear all tracked files without uploading
   */
  clear(): void {
    this.trackedFiles.clear();
  }

  /**
   * Get count of tracked files
   */
  getTrackedCount(): number {
    return this.trackedFiles.size;
  }
}
