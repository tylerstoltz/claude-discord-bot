# Discord Bot Implementation Plan - FINAL
**Based on user requirements**

---

## Summary of Changes

1. **Activity Status**: Global Discord presence + Enhanced terminal logging with debug levels
2. **Slash Commands**: No changes (already working correctly!)
3. **Image Support**: Pass Discord image attachments to Claude Agent SDK (like drag-and-drop in CLI)
4. **File Download**: Both auto-download and manual `/download` command (configurable)
5. **Deployment**: Single server (guild-specific commands for faster updates)
6. **Security**: All settings controlled via config.json

---

## 1. Global Presence Status

### Implementation

**File: `src/bot/activity-manager.ts` (NEW)**
```typescript
import { Client, ActivityType } from 'discord.js';

export type BotActivityStatus = 'idle' | 'thinking' | 'working' | 'writing';

export class ActivityManager {
  private currentStatus: BotActivityStatus = 'idle';
  private lastUpdate: number = 0;
  private updateThrottleMs: number = 5000; // Discord rate limit: max 5 updates/min

  constructor(private client: Client) {}

  setStatus(status: BotActivityStatus): void {
    // Throttle updates to avoid rate limits
    const now = Date.now();
    if (now - this.lastUpdate < this.updateThrottleMs) {
      return;
    }

    if (this.currentStatus === status) {
      return;
    }

    this.currentStatus = status;
    this.lastUpdate = now;

    const statusMap = {
      idle: { type: ActivityType.Custom, name: '💤 Idle' },
      thinking: { type: ActivityType.Custom, name: '🤔 Thinking...' },
      working: { type: ActivityType.Custom, name: '⚙️ Working...' },
      writing: { type: ActivityType.Custom, name: '✍️ Writing...' }
    };

    this.client.user?.setActivity(statusMap[status]);
  }

  reset(): void {
    this.setStatus('idle');
  }
}
```

### Integration Points

1. **discord-client.ts**: Create ActivityManager instance
```typescript
private activityManager!: ActivityManager;

// In setupEventHandlers():
this.activityManager = new ActivityManager(this.client);
```

2. **message-handler.ts**: Update status when processing
```typescript
// After receiving message
activityManager.setStatus('thinking');

// When streaming starts
activityManager.setStatus('writing');

// When complete
activityManager.setStatus('idle');
```

3. **ai-client.ts**: Update status on tool use
```typescript
// In queryWithUpdater(), when tool_use event received:
activityManager?.setStatus('working');
```

---

## 2. Enhanced Terminal Logging

### Configuration
Add debug levels to config.json:
```json
{
  "logLevel": "info",  // "debug" | "info" | "warn" | "error"
  "logTimestamps": true,
  "logColors": true
}
```

### Implementation

**File: `src/logging/logger.ts` (NEW)**
```typescript
import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private level: LogLevel;
  private useTimestamps: boolean;
  private useColors: boolean;

  constructor(level: LogLevel = 'info', useTimestamps = true, useColors = true) {
    this.level = level;
    this.useTimestamps = useTimestamps;
    this.useColors = useColors;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private formatMessage(level: LogLevel, prefix: string, message: string, details?: string): string {
    const timestamp = this.useTimestamps ? `[${new Date().toISOString()}] ` : '';
    const levelStr = level.toUpperCase().padEnd(5);
    const detailsStr = details ? ` | ${details}` : '';

    if (this.useColors) {
      const levelColors = {
        debug: chalk.gray,
        info: chalk.blue,
        warn: chalk.yellow,
        error: chalk.red
      };

      return `${chalk.gray(timestamp)}${levelColors[level](levelStr)} ${prefix} | ${message}${chalk.gray(detailsStr)}`;
    }

    return `${timestamp}${levelStr} ${prefix} | ${message}${detailsStr}`;
  }

  debug(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', prefix, message, details));
    }
  }

  info(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', prefix, message, details));
    }
  }

  warn(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', prefix, message, details));
    }
  }

  error(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', prefix, message, details));
    }
  }

  // Convenience methods with emojis
  channelActivity(channelId: string, activity: string, details?: string): void {
    const shortId = channelId.slice(-6);
    this.info(`📢 Ch:${shortId}`, activity, details);
  }

  toolUse(toolName: string, input: string): void {
    this.debug('⚙️  TOOL', toolName, input.slice(0, 100));
  }

  streaming(bytes: number): void {
    if (this.shouldLog('debug')) {
      process.stdout.write(`  ✍️  Streaming: ${bytes} chars\r`);
    }
  }

  complete(duration: number, cost?: number): void {
    const details = cost ? `Duration: ${duration}ms | Cost: $${cost.toFixed(4)}` : `Duration: ${duration}ms`;
    this.info('✅ COMPLETE', '', details);
  }
}
```

### Usage Throughout Codebase

Replace all `console.log` calls with logger methods:

```typescript
// Before
console.log(`[BOT] Logged in as ${readyClient.user.tag}`);

// After
logger.info('🤖 BOT', `Logged in as ${readyClient.user.tag}`);
```

**Install dependency**: `npm install chalk`

---

## 3. Image Attachment Support

### Key Insight
The Claude Agent SDK accepts `SDKUserMessage` which contains `APIUserMessage` from Anthropic's SDK. The `APIUserMessage` supports content blocks including images (base64 or URLs).

### Implementation

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

**File: `src/attachments/image-processor.ts` (NEW)**
```typescript
import { Attachment } from 'discord.js';
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

      // Check file size
      if (attachment.size > this.config.maxImageSize) {
        this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - too large (${attachment.size} bytes)`);
        continue;
      }

      // Check supported type
      if (!this.config.supportedImageTypes.includes(attachment.contentType)) {
        this.logger.warn('🖼️  IMAGE', `Skipping ${attachment.name} - unsupported type (${attachment.contentType})`);
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
      }
    }

    return images;
  }
}
```

**Modify `src/bot/message-handler.ts`**:
```typescript
import { ImageProcessor } from '../attachments/image-processor.js';

export class MessageHandler {
  private imageProcessor: ImageProcessor;

  constructor(/* ... existing params */, imageProcessor: ImageProcessor) {
    this.imageProcessor = imageProcessor;
  }

  async handleMessage(message: Message): Promise<void> {
    // ... existing code ...

    // Process any image attachments
    const images = await this.imageProcessor.processImages(
      Array.from(message.attachments.values())
    );

    // Build user message with images
    const userMessage = this.buildUserMessage(cleanedContent, images);

    // Query Claude with images
    await this.sessionManager.queryAndStreamWithMessage(
      message.channelId,
      userMessage,
      updater
    );
  }

  private buildUserMessage(text: string, images: ProcessedImage[]): any {
    if (images.length === 0) {
      // Simple text-only message
      return {
        role: 'user',
        content: text
      };
    }

    // Message with images - use content blocks
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
}
```

**Modify `src/agent/session-manager.ts`**:
```typescript
async queryAndStreamWithMessage(
  channelId: string,
  userMessage: any, // MessageParam from Anthropic SDK
  updater: ChunkedUpdater
): Promise<void> {
  const session = await this.getOrCreateSession(channelId);
  session.lastActivity = new Date();

  const aiClient = new AIClient(this.config, this.permissionHook, channelId);

  // Convert to SDK format
  const sdkUserMessage = {
    type: 'user' as const,
    message: userMessage,
    parent_tool_use_id: null
  };

  await aiClient.queryWithSDKMessage(
    sdkUserMessage,
    updater,
    session.sdkSessionId || undefined,
    {
      onSessionInit: (sessionId) => {
        // ... existing code ...
      }
    }
  );
}
```

**Modify `src/agent/ai-client.ts`**:
```typescript
async queryWithSDKMessage(
  sdkMessage: any, // SDKUserMessage
  updater: ChunkedUpdater,
  resumeSessionId?: string,
  callbacks?: QueryCallbacks
): Promise<string | null> {
  // Create async iterable that yields the user message
  const messageStream = async function* () {
    yield sdkMessage;
  };

  const options: any = {
    // ... existing options ...
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  const q = query({
    prompt: messageStream(), // Pass as async iterable
    options
  });

  // ... rest of existing streaming logic ...
}
```

### Configuration
Add to `config.json`:
```json
{
  "attachments": {
    "enabled": true,
    "maxImageSize": 5242880,
    "supportedImageTypes": ["image/jpeg", "image/png", "image/gif", "image/webp"]
  }
}
```

---

## 4. File Download System

### Configuration
```json
{
  "fileDownload": {
    "enabled": true,
    "autoDownload": true,
    "maxFileSize": 8388608,
    "allowedExtensions": [".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log"]
  }
}
```

### Auto-Download Implementation

**Track file creations in `chunked-updater.ts`**:
```typescript
export class ChunkedUpdater {
  private createdFiles: Set<string> = new Set();

  onToolUse(toolName: string, toolInput: unknown): void {
    // ... existing code ...

    // Track file creations
    if (toolName === 'Write' && typeof toolInput === 'object' && toolInput !== null) {
      const input = toolInput as any;
      if (input.file_path) {
        this.createdFiles.add(input.file_path);
      }
    }
  }

  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles);
  }
}
```

**Send files after completion in `message-handler.ts`**:
```typescript
async handleMessage(message: Message): Promise<void> {
  // ... existing code ...

  try {
    await this.sessionManager.queryAndStream(/* ... */);
    await updater.finalize();

    // Auto-download created files if enabled
    if (this.config.fileDownload.enabled && this.config.fileDownload.autoDownload) {
      await this.sendCreatedFiles(channel, updater.getCreatedFiles());
    }
  } finally {
    session.isProcessing = false;
  }
}

private async sendCreatedFiles(channel: TextChannel, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const fs = await import('fs/promises');
  const path = await import('path');

  for (const filePath of files) {
    try {
      // Validate file safety
      if (!this.isPathSafe(filePath)) {
        this.logger.warn('📎 FILE', `Skipping unsafe path: ${filePath}`);
        continue;
      }

      // Check file exists and size
      const stats = await fs.stat(filePath);
      if (stats.size > this.config.fileDownload.maxFileSize) {
        await channel.send(`⚠️ File too large to send: \`${path.basename(filePath)}\` (${stats.size} bytes)`);
        continue;
      }

      // Check extension
      const ext = path.extname(filePath);
      if (!this.config.fileDownload.allowedExtensions.includes(ext)) {
        this.logger.debug('📎 FILE', `Skipping disallowed extension: ${ext}`);
        continue;
      }

      // Read and send file
      const fileBuffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });

      await channel.send({
        content: `📎 Created file: **${fileName}**`,
        files: [attachment]
      });

      this.logger.info('📎 FILE', `Sent ${fileName}`, `${stats.size} bytes`);
    } catch (error) {
      this.logger.error('📎 FILE', `Failed to send ${filePath}`, (error as Error).message);
    }
  }
}

private isPathSafe(filePath: string): boolean {
  const path = require('path');
  const resolved = path.resolve(filePath);
  const cwd = process.cwd();
  return resolved.startsWith(cwd);
}
```

### Manual Download Command

**Add to `slash-commands.ts`**:
```typescript
new SlashCommandBuilder()
  .setName("download")
  .setDescription("Download a file from the bot's workspace")
  .addStringOption(option =>
    option.setName("path")
      .setDescription("File path (relative to workspace)")
      .setRequired(true)
  )
```

**Handler in `SlashCommandHandler`**:
```typescript
private async handleDownload(
  interaction: ChatInputCommandInteraction,
  channelId: string
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const filePath = interaction.options.getString("path", true);
  const path = await import('path');
  const fs = await import('fs/promises');

  // Resolve path relative to cwd
  const resolved = path.resolve(process.cwd(), filePath);

  // Security check
  if (!resolved.startsWith(process.cwd())) {
    await interaction.editReply("❌ Invalid path - must be within workspace.");
    return;
  }

  try {
    const stats = await fs.stat(resolved);

    if (stats.size > this.config.fileDownload.maxFileSize) {
      await interaction.editReply(`❌ File too large (${stats.size} bytes).`);
      return;
    }

    const fileBuffer = await fs.readFile(resolved);
    const fileName = path.basename(resolved);
    const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });

    await interaction.editReply({
      content: `📎 Here's your file: **${fileName}**`,
      files: [attachment]
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await interaction.editReply(`❌ File not found: \`${filePath}\``);
    } else {
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  }
}
```

---

## 5. Guild-Specific Command Registration

**Modify `config.json`**:
```json
{
  "guildId": "YOUR_SERVER_ID_HERE"
}
```

**Modify `slash-commands.ts`**:
```typescript
export async function registerCommands(
  token: string,
  clientId: string,
  guildId?: string
): Promise<void> {
  const rest = new REST().setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  try {
    console.log(`Registering slash commands (${guildId ? 'guild-specific' : 'global'})...`);
    await rest.put(route, {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}
```

**Call with guildId from `discord-client.ts`**:
```typescript
await registerCommands(
  this.config.discordToken,
  readyClient.user.id,
  this.config.guildId // Pass from config
);
```

---

## 6. Updated Config Schema

**File: `src/config.ts`** - Add new fields:
```typescript
export interface BotConfig {
  // Existing fields...
  discordToken: string;
  monitorMentions: boolean;
  monitorAllMessages: boolean;
  allowedChannels: string[];
  maxMessageLength: number;
  model: "sonnet" | "opus" | "haiku";
  allowedTools: string[];
  dangerousTools: string[];
  updateIntervalMs: number;
  sessionPersistPath: string;
  permissionTimeoutMs: number;

  // NEW: Guild ID for faster command registration
  guildId?: string;

  // NEW: Logging configuration
  logLevel: "debug" | "info" | "warn" | "error";
  logTimestamps: boolean;
  logColors: boolean;

  // NEW: Attachment configuration
  attachments: {
    enabled: boolean;
    maxImageSize: number;
    supportedImageTypes: string[];
  };

  // NEW: File download configuration
  fileDownload: {
    enabled: boolean;
    autoDownload: boolean;
    maxFileSize: number;
    allowedExtensions: string[];
  };
}

const defaultConfig: BotConfig = {
  // ... existing defaults ...

  logLevel: "info",
  logTimestamps: true,
  logColors: true,

  attachments: {
    enabled: true,
    maxImageSize: 5 * 1024 * 1024, // 5 MB
    supportedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"]
  },

  fileDownload: {
    enabled: true,
    autoDownload: true,
    maxFileSize: 8 * 1024 * 1024, // 8 MB (Discord free tier limit)
    allowedExtensions: [".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log"]
  }
};
```

---

## Implementation Order

### Phase 1: Logging & Status (Est. 3-4 hours)
1. Create `src/logging/logger.ts`
2. Create `src/bot/activity-manager.ts`
3. Update `config.ts` with logging fields
4. Replace `console.log` calls throughout codebase
5. Integrate ActivityManager in message-handler and ai-client
6. Test logging levels and presence updates

### Phase 2: Image Support (Est. 4-5 hours)
7. Create `src/types/attachment-types.ts`
8. Create `src/attachments/image-processor.ts`
9. Update `config.ts` with attachment fields
10. Modify `message-handler.ts` to process images
11. Modify `session-manager.ts` to accept structured messages
12. Modify `ai-client.ts` to support SDK user messages
13. Test with various image types and sizes

### Phase 3: File Download (Est. 3-4 hours)
14. Update `chunked-updater.ts` to track file creations
15. Add file sending logic to `message-handler.ts`
16. Update `config.ts` with fileDownload fields
17. Add `/download` command to `slash-commands.ts`
18. Test auto-download and manual download

### Phase 4: Guild Commands & Polish (Est. 1-2 hours)
19. Add `guildId` to config
20. Update command registration logic
21. Final testing of all features together
22. Update README.md with new features

**Total Estimated Time: 11-15 hours**

---

## Testing Checklist

### Activity Status
- [ ] Presence shows "💤 Idle" when no activity
- [ ] Presence updates to "🤔 Thinking..." on message receive
- [ ] Presence updates to "⚙️ Working..." during tool use
- [ ] Presence updates to "✍️ Writing..." during streaming
- [ ] Presence returns to idle after completion
- [ ] Terminal logs show with correct colors and timestamps
- [ ] Debug level hides debug logs, info level shows them

### Image Support
- [ ] Single image upload works
- [ ] Multiple images in one message work
- [ ] Large images are rejected with warning
- [ ] Unsupported formats are rejected
- [ ] Claude receives and analyzes images correctly
- [ ] Images work with and without text in message
- [ ] Error handling for CDN download failures

### File Download
- [ ] Auto-download sends files created by Write tool
- [ ] Large files show warning instead of sending
- [ ] Disallowed extensions are skipped
- [ ] `/download` command works with valid paths
- [ ] `/download` rejects paths outside workspace
- [ ] `/download` handles missing files gracefully
- [ ] File attachments appear correctly in Discord

### Guild Commands
- [ ] Commands register to specific guild (instant)
- [ ] All existing commands still work
- [ ] `/download` command appears in slash command list

---

## Dependencies to Install

```bash
npm install chalk
```

That's it! All other dependencies already exist.

---

## Example config.json

```json
{
  "discordToken": "YOUR_BOT_TOKEN",
  "guildId": "YOUR_GUILD_ID",
  "monitorMentions": true,
  "monitorAllMessages": false,
  "allowedChannels": [],
  "maxMessageLength": 2000,
  "model": "sonnet",
  "allowedTools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  "dangerousTools": ["Bash", "Write", "Edit"],
  "updateIntervalMs": 3000,
  "sessionPersistPath": "./data/sessions.json",
  "permissionTimeoutMs": 60000,

  "logLevel": "info",
  "logTimestamps": true,
  "logColors": true,

  "attachments": {
    "enabled": true,
    "maxImageSize": 5242880,
    "supportedImageTypes": ["image/jpeg", "image/png", "image/gif", "image/webp"]
  },

  "fileDownload": {
    "enabled": true,
    "autoDownload": true,
    "maxFileSize": 8388608,
    "allowedExtensions": [".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log"]
  }
}
```

---

## Migration Notes

- Existing sessions will continue to work
- No breaking changes to existing functionality
- All new features are configurable and can be disabled
- Default config values maintain current behavior

---

## Security Considerations

1. **Path Traversal**: All file paths validated to stay within workspace
2. **File Size Limits**: Enforced for both uploads and downloads
3. **Type Validation**: Only allowed image types and file extensions processed
4. **Rate Limiting**: Presence updates throttled to avoid Discord rate limits
5. **Error Handling**: All network/file operations wrapped in try-catch

---

Ready to implement! 🚀
