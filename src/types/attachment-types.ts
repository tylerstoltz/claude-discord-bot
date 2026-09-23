export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ProcessedImage {
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
  name: string;
  size: number;
}

export interface AttachmentConfig {
  enabled: boolean;
  maxImageSize: number; // bytes
  supportedImageTypes: string[];
}
