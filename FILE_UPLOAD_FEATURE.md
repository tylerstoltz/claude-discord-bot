# File Upload Feature

## Overview
Claude can now upload files it creates (via the Write tool) as Discord attachments automatically.

## How It Works

1. **File Tracking**: When Claude uses the `Write` tool, the `FileUploadManager` tracks the file path
2. **Validation**: Files are validated against size limits and allowed extensions
3. **Auto-Upload**: After the response is complete, tracked files are automatically uploaded to Discord
4. **User Notification**: Files appear in Discord with a "📎 **Files created:**" message

## Configuration

Add to your `config.json`:

```json
{
  "fileUpload": {
    "enabled": true,
    "autoUpload": true,
    "maxFileSize": 26214400,
    "allowedExtensions": [
      ".txt", ".md", ".json", ".js", ".ts", ".py",
      ".csv", ".log", ".svg", ".html", ".xml", ".yml", ".yaml"
    ]
  }
}
```

### Options

- **enabled** (boolean): Enable/disable file upload feature
- **autoUpload** (boolean): Automatically upload files created by Write tool
- **maxFileSize** (number): Maximum file size in bytes (default: 25MB)
- **allowedExtensions** (string[]): List of allowed file extensions

## Example Usage

**User in Discord:**
```
@Bot create an SVG circle for me
```

**Claude's Response:**
```
I'll create an SVG circle for you.

> **Using:** `Write`
> {"file_path": "circle.svg", ...}

I've created a circle SVG file with a red circle centered at (100, 100) with a radius of 50 pixels.

📎 **Files created:**
[circle.svg attachment appears here]
```

## Supported File Types (Default)

- **Code**: .js, .ts, .py
- **Markup**: .html, .svg, .xml
- **Data**: .json, .csv, .yml, .yaml
- **Text**: .txt, .md, .log

## Technical Details

### Architecture

- **FileUploadManager**: Tracks and validates files, handles Discord uploads
- **ChunkedUpdater**: Intercepts `Write` tool usage, triggers uploads after finalization
- **MessageHandler**: Initializes the FileUploadManager per message

### File Tracking Flow

1. Claude uses Write tool → `ChunkedUpdater.onToolUse()` called
2. If toolName === 'Write' → `FileUploadManager.trackFile(filePath)`
3. File path stored in Set
4. Response completes → `ChunkedUpdater.finalize()` called
5. `FileUploadManager.uploadTrackedFiles()` validates and uploads files
6. Files sent as Discord attachments

### Validation

Files are skipped if they:
- Don't exist
- Exceed maxFileSize
- Have disallowed extensions
- Can't be read

## Limitations

- Maximum file size is 25MB (Discord free tier limit)
- Only files created via the Write tool are tracked
- Files must have allowed extensions
- No support for binary files (images, PDFs, etc.) - use image attachments for those

## Future Enhancements

- Support for image files created by Claude
- Batch upload optimization
- Custom upload messages per file type
- File compression for large files
