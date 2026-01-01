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
        const base64 = Buffer.from(arrayBuffer).toString('base64');

        images.push({
          source: {
            type: 'base64',
            media_type: attachment.contentType,
            data: base64
          },
          name: attachment.name,
          size: attachment.size
        });

        this.logger.info('🖼️  IMAGE', `Processed ${attachment.name}`, `${attachment.size} bytes`);
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
}
