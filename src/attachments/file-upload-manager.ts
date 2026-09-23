import { AttachmentBuilder, type SendableChannels } from 'discord.js';
import { stat, readFile, realpath } from 'fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'path';
import type { Logger } from '../logging/logger.js';

export interface FileUploadConfig {
  enabled: boolean;
  autoUpload: boolean;
  maxFileSize: number;
  allowedExtensions: string[];
  allowedDirs: string[];
}

/** Files that hold the bot's own secrets. Never uploaded, whatever allowedDirs says. */
function secretFiles(): string[] {
  return [
    resolve(process.env.BOT_CONFIG_PATH || 'config.json'),
    resolve('config.json'),
    resolve('CLAUDE.local.md'),
    resolve('data/sessions.json'),
  ];
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Uploads files from Claude to Discord. Create one per reply: tracked files belong
 * to the reply that wrote them.
 */
export class FileUploadManager {
  private trackedFiles: Set<string> = new Set();

  constructor(
    private config: FileUploadConfig,
    private logger: Logger
  ) {}

  /**
   * Track a file successfully written by Claude's Write tool
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
   * Validate if a file may be uploaded
   */
  async validateFile(filePath: string): Promise<{ valid: boolean; reason?: string; realPath?: string }> {
    try {
      // Resolve symlinks so a link inside an allowed dir can't point outside it
      const realPath = await realpath(resolve(process.cwd(), filePath));

      const secrets = await Promise.all(secretFiles().map(realpathOrResolve));
      if (secrets.includes(realPath) || basename(realPath).startsWith('.env')) {
        return { valid: false, reason: 'Bot secret file' };
      }

      if (this.config.allowedDirs.length > 0) {
        const dirs = await Promise.all(this.config.allowedDirs.map(realpathOrResolve));
        if (!dirs.some((dir) => isInside(dir, realPath))) {
          return { valid: false, reason: `Outside allowed dirs (${this.config.allowedDirs.join(', ')})` };
        }
      }

      const stats = await stat(realPath);

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
      const ext = extname(realPath).toLowerCase();
      if (this.config.allowedExtensions.length > 0 && !this.config.allowedExtensions.includes(ext)) {
        return { valid: false, reason: `Extension ${ext} not allowed` };
      }

      return { valid: true, realPath };
    } catch (error) {
      return { valid: false, reason: (error as Error).message };
    }
  }

  /**
   * Upload all tracked files (auto-upload of Write tool output)
   */
  async uploadTrackedFiles(channel: SendableChannels): Promise<number> {
    const files = [...this.trackedFiles];
    this.trackedFiles.clear();

    if (!this.config.autoUpload || files.length === 0) {
      return 0;
    }

    return this.uploadFiles(channel, files, '📎 **Files created:**');
  }

  /**
   * Upload specific files by path (used for [UPLOAD: path] markers)
   */
  async uploadFiles(channel: SendableChannels, filePaths: string[], message: string): Promise<number> {
    if (!this.config.enabled) {
      this.logger.warn('📤 UPLOAD', 'File upload is disabled in config');
      return 0;
    }

    const attachments: AttachmentBuilder[] = [];

    for (const filePath of filePaths) {
      const validation = await this.validateFile(filePath);

      if (!validation.valid || !validation.realPath) {
        this.logger.warn('📤 UPLOAD', `Skipping ${basename(filePath)}`, validation.reason || 'unknown');
        continue;
      }

      try {
        const fileBuffer = await readFile(validation.realPath);
        const fileName = basename(filePath);
        attachments.push(new AttachmentBuilder(fileBuffer, { name: fileName }));
        this.logger.info('📤 UPLOAD', `Prepared ${fileName}`, `${fileBuffer.length} bytes`);
      } catch (error) {
        this.logger.error('📤 UPLOAD', `Failed to read ${basename(filePath)}`, (error as Error).message);
      }
    }

    if (attachments.length === 0) {
      return 0;
    }

    try {
      await channel.send({ content: message, files: attachments });
      this.logger.info('📤 UPLOAD', `Uploaded ${attachments.length} file(s)`);
      return attachments.length;
    } catch (error) {
      this.logger.error('📤 UPLOAD', 'Failed to upload files', (error as Error).message);
      return 0;
    }
  }
}
