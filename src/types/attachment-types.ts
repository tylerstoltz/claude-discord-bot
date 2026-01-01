export interface ProcessedImage {
  source: {
    type: 'base64';
    media_type: string;
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
