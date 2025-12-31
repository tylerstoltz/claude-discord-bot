# Phase 2: Image Support - Detailed Specification

## Overview
Implement image attachment support so Discord users can send images to Claude for analysis, exactly like drag-and-drop in the Claude Code CLI.

---

## Goals
1. Download image attachments from Discord messages
2. Convert images to base64 format
3. Pass images to Claude Agent SDK via content blocks
4. Support multiple images per message
5. Handle errors gracefully (size limits, unsupported formats)

---

## Technical Approach

### How It Works
The Claude Agent SDK accepts `SDKUserMessage` which contains an `APIUserMessage` from the Anthropic SDK. Messages can have **content blocks** that include both text and images:

```typescript
// Simple text message
{
  role: 'user',
  content: 'What is this?'
}

// Message with text + images
{
  role: 'user',
  content: [
    { type: 'text', text: 'What is this?' },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: '<base64-encoded-image-data>'
      }
    }
  ]
}
```

### SDK Integration
The SDK's `query()` function accepts an async iterable of `SDKUserMessage`:

```typescript
const messageStream = async function* () {
  yield {
    type: 'user' as const,
    message: {
      role: 'user',
      content: [/* text + image blocks */]
    },
    parent_tool_use_id: null
  };
};

const q = query({
  prompt: messageStream(),
  options: { /* ... */ }
});
```

---

## Implementation Details

### 1. New Type Definitions

**File: `src/types/attachment-types.ts` (NEW)**
```typescript
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
```

---

### 2. Image Processor

**File: `src/attachments/image-processor.ts` (NEW)**

**Responsibilities:**
- Filter Discord attachments for images
- Validate file size and type
- Download images from Discord CDN
- Convert to base64
- Log processing activity

**Key Methods:**
```typescript
class ImageProcessor {
  constructor(config: AttachmentConfig, logger: Logger);

  async processImages(attachments: Attachment[]): Promise<ProcessedImage[]>;
  private validateAttachment(attachment: Attachment): boolean;
}
```

**Implementation Notes:**
- Use `fetch()` to download from `attachment.url`
- Discord CDN URLs are temporary but valid for message processing
- Handle network errors gracefully
- Log each image processed with size

**Size Limits:**
- Discord attachments already limited by server tier (8 MB / 50 MB / 100 MB)
- Claude API limit: 5 MB per image
- Enforce 5 MB limit in config (already set in defaults)

**Supported Formats:**
- `image/jpeg`
- `image/png`
- `image/gif`
- `image/webp`

---

### 3. Message Handler Updates

**File: `src/bot/message-handler.ts` (MODIFY)**

**Changes Required:**

1. **Add ImageProcessor instance:**
```typescript
export class MessageHandler {
  private imageProcessor: ImageProcessor;

  constructor(
    private config: BotConfig,
    private sessionManager: SessionManager,
    private botUserId: string,
    private logger: Logger,
    private activityManager: ActivityManager
  ) {
    this.imageProcessor = new ImageProcessor(
      config.attachments,
      logger
    );
  }
}
```

2. **Process attachments in handleMessage():**
```typescript
async handleMessage(message: Message): Promise<void> {
  // ... existing code ...

  const startTime = Date.now();
  this.logger.channelActivity(message.channelId, 'RECEIVED', cleanedContent.slice(0, 100));

  // NEW: Process image attachments
  const images = await this.imageProcessor.processImages(
    Array.from(message.attachments.values())
  );

  if (images.length > 0) {
    this.logger.info('🖼️  IMAGES', `Processing ${images.length} image(s)`);
  }

  // Update bot status
  this.activityManager.setStatus('thinking');

  // ... rest of existing code ...

  try {
    await channel.sendTyping();

    // NEW: Query with images
    await this.sessionManager.queryAndStreamWithImages(
      message.channelId,
      cleanedContent,
      images,
      updater
    );

    await updater.finalize();
    const duration = Date.now() - startTime;
    this.logger.complete(duration);
  } catch (error) {
    this.logger.error('💬 MSG', 'Error processing message', (error as Error).message);
    await updater.sendError(`Error: ${(error as Error).message}`);
  } finally {
    session.isProcessing = false;
    this.activityManager.reset();
  }
}
```

---

### 4. Session Manager Updates

**File: `src/agent/session-manager.ts` (MODIFY)**

**Add new method:**
```typescript
async queryAndStreamWithImages(
  channelId: string,
  text: string,
  images: ProcessedImage[],
  updater: ChunkedUpdater
): Promise<void> {
  const session = await this.getOrCreateSession(channelId);
  session.lastActivity = new Date();

  // Build user message with text + images
  const userMessage = this.buildUserMessage(text, images);

  const aiClient = new AIClient(this.config, this.permissionHook, channelId);

  await aiClient.queryWithMessage(
    userMessage,
    updater,
    session.sdkSessionId || undefined,
    {
      onSessionInit: (sessionId) => {
        this.logger.debug('💾 SESSION', `Got session ID: ${sessionId.slice(0, 8)}`);
        session.sdkSessionId = sessionId;
        this.sessionStore.setSessionId(channelId, sessionId);
        this.sessionStore.save().catch((err) =>
          this.logger.error('💾 SESSION', 'Failed to persist', err.message)
        );
      },
    }
  );

  this.sessionStore.updateActivity(channelId);
}

private buildUserMessage(text: string, images: ProcessedImage[]): any {
  if (images.length === 0) {
    // Simple text message
    return {
      role: 'user',
      content: text
    };
  }

  // Message with text + images - use content blocks
  const content: any[] = [
    { type: 'text', text }
  ];

  for (const img of images) {
    content.push({
      type: 'image',
      source: img.source
    });
  }

  return {
    role: 'user',
    content
  };
}
```

**Keep existing `queryAndStream()` method:**
- Used for text-only messages (backward compatible)
- Calls new method with empty images array

---

### 5. AI Client Updates

**File: `src/agent/ai-client.ts` (MODIFY)**

**Add new method:**
```typescript
async queryWithMessage(
  userMessage: any, // MessageParam from Anthropic SDK
  updater: ChunkedUpdater,
  resumeSessionId?: string,
  callbacks?: QueryCallbacks
): Promise<void> {
  // Create async iterable that yields the SDK user message
  const messageStream = async function* () {
    yield {
      type: 'user' as const,
      message: userMessage,
      parent_tool_use_id: null
    };
  };

  const options: any = {
    maxTurns: 100,
    model: this.config.model,
    allowedTools: this.config.allowedTools,
    cwd: process.cwd(),
    executable: "/usr/bin/node",
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  // Add permission hooks if configured
  if (this.permissionHook && this.config.dangerousTools.length > 0) {
    const matcher = this.config.dangerousTools.join("|");
    options.hooks = {
      PreToolUse: [
        {
          matcher,
          hooks: [this.permissionHook.createHookHandler(this.channelId)],
        },
      ],
    };
  }

  try {
    const q = query({
      prompt: messageStream(), // Pass as async iterable
      options
    });

    // Stream events (same as existing queryStream logic)
    for await (const message of q) {
      if (message.type === "system" && (message as any).subtype === "init") {
        const sessionId = (message as any).session_id;
        callbacks?.onSessionInit?.(sessionId);
      } else if (message.type === "assistant") {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              updater.appendContent(block.text);
              callbacks?.onText?.(block.text);
            } else if (block.type === "tool_use") {
              updater.onToolUse(block.name, block.input);
              callbacks?.onToolUse?.(block.name, block.input);
            }
          }
        } else if (typeof content === "string") {
          updater.appendContent(content);
          callbacks?.onText?.(content);
        }
      } else if (message.type === "result") {
        callbacks?.onResult?.(
          (message as any).subtype === "success",
          (message as any).total_cost_usd
        );
      }
    }
  } catch (error) {
    console.error("[AI] Query error:", error);
    throw error;
  }
}
```

**Refactor existing `queryWithUpdater()`:**
- Can call `queryWithMessage()` internally
- Or keep separate for text-only optimization

---

## Error Handling

### Image Processing Errors
```typescript
// In ImageProcessor.processImages()
try {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  // ... success
} catch (error) {
  this.logger.error('🖼️  IMAGE', `Failed to process ${attachment.name}`, (error as Error).message);
  // Continue processing other images - don't fail entire message
}
```

### Size Validation
```typescript
if (attachment.size > this.config.maxImageSize) {
  this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - too large (${attachment.size} bytes)`);
  continue; // Skip this image
}
```

### Type Validation
```typescript
if (!this.config.supportedImageTypes.includes(attachment.contentType)) {
  this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - unsupported type (${attachment.contentType})`);
  continue; // Skip this image
}
```

### User Feedback
- If images are skipped, user sees warnings in Claude's response context
- Claude still responds with whatever images were successfully processed
- If all images fail, message is treated as text-only

---

## Testing Checklist

### Basic Functionality
- [ ] Single image upload works
- [ ] Multiple images in one message work
- [ ] Image + text in same message works
- [ ] Image-only message works (empty text)
- [ ] Claude receives and analyzes images correctly

### Format Support
- [ ] JPEG images work
- [ ] PNG images work
- [ ] GIF images work
- [ ] WebP images work
- [ ] Unsupported formats are rejected gracefully

### Size Limits
- [ ] Images under 5 MB process successfully
- [ ] Images over 5 MB are rejected with warning
- [ ] Multiple small images within total size work
- [ ] Discord's server-tier limits are respected

### Error Handling
- [ ] Network errors during download don't crash bot
- [ ] Corrupted images are handled gracefully
- [ ] Partial success (some images work, some fail) works
- [ ] All images failing still sends text message

### Logging
- [ ] Image processing logged at info level
- [ ] Skipped images logged at warn level
- [ ] Image size and format logged at debug level
- [ ] Errors logged with details

### Performance
- [ ] Multiple images download in parallel
- [ ] Large images don't block message processing
- [ ] Memory usage stays reasonable
- [ ] Bot remains responsive during image processing

---

## Configuration

All configuration already exists in `config.ts`:

```json
{
  "attachments": {
    "enabled": true,
    "maxImageSize": 5242880,
    "supportedImageTypes": ["image/jpeg", "image/png", "image/gif", "image/webp"]
  }
}
```

**To disable image support:**
```json
{
  "attachments": {
    "enabled": false
  }
}
```

---

## User Experience

### Before (Text Only):
```
User: What is this?
[uploads image.jpg]

Bot: I don't have access to images in this conversation.
```

### After (Image Support):
```
User: What is this?
[uploads image.jpg]

Bot: This is a photograph of a sunset over the ocean. The image shows...
```

### Multiple Images:
```
User: Compare these two screenshots
[uploads screenshot1.png, screenshot2.png]

Bot: Looking at both screenshots:
Screenshot 1 shows...
Screenshot 2 shows...
The main differences are...
```

### Mixed Content:
```
User: Fix the bug in this code
[uploads code_screenshot.png]

Bot: I can see the issue in line 15 of your code. The problem is...
```

---

## Integration Points

### Files to Create:
1. `src/types/attachment-types.ts` - Type definitions
2. `src/attachments/image-processor.ts` - Image processing logic

### Files to Modify:
1. `src/bot/message-handler.ts` - Add image processing
2. `src/agent/session-manager.ts` - Add image message method
3. `src/agent/ai-client.ts` - Add SDK message support

### Files Already Ready:
1. `src/config.ts` - Attachment config already added ✅
2. `src/logging/logger.ts` - Logger ready for image logs ✅

---

## Dependencies

No new dependencies needed! Everything uses built-in Node.js APIs:
- `fetch()` - Download images (built-in in Node 18+)
- `Buffer` - Base64 encoding (built-in)
- Discord.js types - Already installed

---

## Backward Compatibility

### Text-Only Messages
- Existing `queryAndStream()` method unchanged
- Falls back to text-only when no images present
- Existing sessions continue to work

### Session Resumption
- Images are part of conversation context
- SDK handles image persistence in session
- Resumed sessions can reference previous images

---

## Security Considerations

### URL Validation
- Only process Discord CDN URLs (discord.com/attachments/*)
- Don't follow redirects to external sites
- Validate content-type header matches file extension

### Size Limits
- Enforce max image size (5 MB)
- Total message size limited by Discord
- Prevent memory exhaustion from large images

### Content Type Validation
- Whitelist specific MIME types
- Reject executables disguised as images
- Validate image headers (magic bytes)

---

## Future Enhancements (Not in Phase 2)

### Phase 3 Considerations:
- PDF support (text extraction + page images)
- Document file support (.docx, .txt, etc.)
- Video frame extraction
- Archive file support (.zip with images)

### Potential Optimizations:
- Image compression before sending to API
- Thumbnail generation for large images
- Caching processed images (short TTL)
- Batch image processing

---

## Estimated Implementation Time

- **Type definitions**: 15 minutes
- **ImageProcessor class**: 1-2 hours
- **MessageHandler integration**: 1 hour
- **SessionManager updates**: 1 hour
- **AIClient updates**: 1-2 hours
- **Testing and debugging**: 1-2 hours

**Total: 4-6 hours**

---

## Success Criteria

Phase 2 is complete when:
1. ✅ Users can upload images in Discord
2. ✅ Images are downloaded and processed
3. ✅ Images are passed to Claude SDK
4. ✅ Claude analyzes and responds about images
5. ✅ Multiple images work in one message
6. ✅ Size and format limits enforced
7. ✅ Errors handled gracefully
8. ✅ Logging shows image processing
9. ✅ Backward compatible with text-only
10. ✅ All tests pass

---

## Notes

- The Claude Agent SDK handles image tokens and API costs automatically
- Images count toward context window (varies by resolution)
- Discord's typing indicator shows while processing images
- Bot presence status already updates during processing (Phase 1)

---

## References

- Claude Messages API: https://docs.anthropic.com/en/api/messages
- Vision guide: https://docs.anthropic.com/en/docs/build-with-claude/vision
- Discord.js Attachment: https://discord.js.org/docs/packages/discord.js/main/Attachment:Class
- Claude Agent SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts`
