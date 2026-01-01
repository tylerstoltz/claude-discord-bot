import type { Attachment } from 'discord.js';
import type { ProcessedImage, AttachmentConfig } from '../types/attachment-types.js';
import type { Logger } from '../logging/logger.js';

export class ImageProcessor {
  constructor(
    private config: AttachmentConfig,
    private logger: Logger
  ) {}

  async processImages(attachments: Attachment[]): Promise<ProcessedImage[]> {
    if (!this.config.enabled) {
      return [];
    }

    const images: ProcessedImage[] = [];

    for (const attachment of attachments) {
      // Filter for images only
      if (!attachment.contentType?.startsWith('image/')) {
        continue;
      }

      // Validate attachment
      if (!this.validateAttachment(attachment)) {
        continue;
      }

      try {
        // Download image from Discord CDN
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Detect actual image format from file header (magic bytes)
        const actualMediaType = this.detectImageFormat(buffer);

        if (!actualMediaType) {
          this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - could not detect valid image format`);
          continue;
        }

        const base64 = buffer.toString('base64');

        images.push({
          source: {
            type: 'base64',
            media_type: actualMediaType,
            data: base64
          },
          name: attachment.name,
          size: attachment.size
        });

        this.logger.info('🖼️  IMAGE', `Processed ${attachment.name}`, `${attachment.size} bytes, format: ${actualMediaType}`);
      } catch (error) {
        this.logger.error('🖼️  IMAGE', `Failed to process ${attachment.name}`, (error as Error).message);
        // Continue processing other images - don't fail entire message
      }
    }

    return images;
  }

  private validateAttachment(attachment: Attachment): boolean {
    // Check file size
    if (attachment.size > this.config.maxImageSize) {
      this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - too large`, `${attachment.size} bytes (max: ${this.config.maxImageSize})`);
      return false;
    }

    // Check supported type
    if (!attachment.contentType || !this.config.supportedImageTypes.includes(attachment.contentType)) {
      this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - unsupported type`, attachment.contentType || 'unknown');
      return false;
    }

    return true;
  }

  /**
   * Detect image format from file header (magic bytes)
   * This is more reliable than trusting the Content-Type header
   */
  private detectImageFormat(buffer: Buffer): string | null {
    if (buffer.length < 12) {
      return null;
    }

    // Check for PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return 'image/png';
    }

    // Check for JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }

    // Check for GIF: 47 49 46 38 (GIF8)
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return 'image/gif';
    }

    // Check for WebP: RIFF....WEBP
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp';
    }

    return null;
  }
}
