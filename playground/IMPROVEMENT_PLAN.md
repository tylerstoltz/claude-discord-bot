# Discord Bot Improvement Plan

This document outlines the implementation plan for three major improvements to the Claude Discord Bot.

---

## 1. Activity Status Indicators

### Problem
Currently, users can't easily tell when the bot is still working vs finished responding. The only indicators are:
- Discord's built-in "typing" indicator (limited duration ~10 seconds)
- An hourglass reaction (⏳) when a message arrives while processing another
- Terminal logs (not visible to Discord users)

### Proposed Solutions

#### Option A: Discord Presence/Status Updates (Recommended)
**What:** Update the bot's Discord presence status in real-time to show activity.

**Implementation:**
```typescript
// In DiscordBot class (discord-client.ts)
updateBotStatus(status: 'idle' | 'thinking' | 'working' | 'writing') {
  const statusMap = {
    idle: { type: ActivityType.Custom, name: '💤 Idle' },
    thinking: { type: ActivityType.Custom, name: '🤔 Thinking...' },
    working: { type: ActivityType.Custom, name: '⚙️ Working on it...' },
    writing: { type: ActivityType.Custom, name: '✍️ Writing response...' }
  };

  this.client.user?.setActivity(statusMap[status]);
}
```

**Integration Points:**
- `message-handler.ts`: Set to "thinking" when message received
- `ai-client.ts` callbacks: Set to "working" on tool use
- `chunked-updater.ts`: Set to "writing" when streaming text
- `message-handler.ts`: Set to "idle" after finalize()

**Pros:**
- Visible to all users in the server
- Shows in member list and bot profile
- Non-intrusive
- Real-time updates

**Cons:**
- Global status (shared across all channels)
- Limited to ~128 characters

#### Option B: Per-Channel Status Messages
**What:** Send/edit a status message in the channel showing current activity.

**Implementation:**
```typescript
// In ChunkedUpdater class
private statusMessage: Message | null = null;

async updateStatus(status: string) {
  const statusEmbed = new EmbedBuilder()
    .setColor(0x5865F2) // Blurple
    .setDescription(`${status}`)
    .setTimestamp();

  if (!this.statusMessage) {
    this.statusMessage = await this.channel.send({ embeds: [statusEmbed] });
  } else {
    await this.statusMessage.edit({ embeds: [statusEmbed] });
  }
}

async removeStatus() {
  if (this.statusMessage) {
    await this.statusMessage.delete();
    this.statusMessage = null;
  }
}
```

**Status Progression:**
1. "🤔 Processing your request..."
2. "⚙️ Using tool: `Bash` - Running command..."
3. "✍️ Writing response..."
4. "✅ Complete!" (then auto-delete after 2s)

**Pros:**
- Per-channel visibility
- More detailed status information
- Can show tool names and progress

**Cons:**
- Creates extra messages (clutter)
- Rate limit concerns with frequent updates
- Message management complexity

#### Option C: Enhanced Terminal Logging
**What:** Improve terminal output with better formatting and progress indicators.

**Implementation:**
```typescript
// New file: src/logging/activity-logger.ts
export class ActivityLogger {
  private logStream = process.stdout;

  logChannelActivity(channelId: string, status: string, details?: string) {
    const timestamp = new Date().toISOString();
    const channelShort = channelId.slice(-6);

    // Use ANSI colors for better visibility
    console.log(`[${timestamp}] 📢 Ch:${channelShort} | ${status}${details ? ` | ${details}` : ''}`);
  }

  logToolUse(channelId: string, toolName: string, input: string) {
    console.log(`  ⚙️  Tool: ${toolName}`);
    console.log(`  📝  Input: ${input.slice(0, 100)}...`);
  }

  logProgress(channelId: string, bytesStreamed: number) {
    // Use \r to overwrite line for progress
    process.stdout.write(`  ✍️  Streaming: ${bytesStreamed} chars\r`);
  }
}
```

**Enhanced Logs:**
```
[2024-01-15T10:30:45.123Z] 📢 Ch:abc123 | RECEIVED | "Help me with..."
  🤔 Processing...
  ⚙️ Tool: Read | file.ts
  ⚙️ Tool: Grep | pattern: "function"
  ✍️ Streaming: 1250 chars
  ✅ COMPLETE | Duration: 8.5s | Cost: $0.042
[2024-01-15T10:30:53.789Z] 📢 Ch:abc123 | IDLE
```

**Pros:**
- Doesn't affect Discord experience
- Detailed debugging information
- No rate limits
- Easy to implement

**Cons:**
- Only visible to bot operator
- Doesn't help Discord users

### Recommendation
**Implement a combination of Option A + Option C:**

1. **Discord Presence** for user-facing status (Option A)
2. **Enhanced Terminal Logging** for bot operator monitoring (Option C)

This gives:
- Users can see when bot is active (presence status)
- Operators get detailed logs for debugging
- No message clutter in channels
- No additional rate limit concerns

### Files to Modify
- `src/bot/discord-client.ts` - Add presence update methods
- `src/bot/message-handler.ts` - Update status on message receive/complete
- `src/agent/ai-client.ts` - Update status on tool use via callbacks
- `src/streaming/chunked-updater.ts` - Update status during streaming
- `src/logging/activity-logger.ts` - **NEW FILE** for enhanced terminal logging

---

## 2. Proper Discord Slash Commands

### Current State
Slash commands ARE already registered as proper Discord slash commands!

**Evidence:**
- `src/bot/slash-commands.ts` already uses `SlashCommandBuilder`
- `registerCommands()` function uses Discord REST API to register globally
- Commands registered: `/compact`, `/clear`, `/status`
- Handler already exists in `SlashCommandHandler` class

### Proposed Improvements

#### A. Add More Useful Commands

**New Commands to Add:**
```typescript
// In slash-commands.ts
new SlashCommandBuilder()
  .setName("model")
  .setDescription("Change the Claude model for this channel")
  .addStringOption(option =>
    option.setName("model")
      .setDescription("Choose model")
      .setRequired(true)
      .addChoices(
        { name: 'Claude Sonnet (Balanced)', value: 'sonnet' },
        { name: 'Claude Opus (Most Capable)', value: 'opus' },
        { name: 'Claude Haiku (Fastest)', value: 'haiku' }
      )
  ),

new SlashCommandBuilder()
  .setName("context")
  .setDescription("Show conversation context statistics")
  .addBooleanOption(option =>
    option.setName("detailed")
      .setDescription("Show detailed token breakdown")
      .setRequired(false)
  ),

new SlashCommandBuilder()
  .setName("export")
  .setDescription("Export conversation history to JSON file"),

new SlashCommandBuilder()
  .setName("tools")
  .setDescription("Manage tool permissions")
  .addStringOption(option =>
    option.setName("action")
      .setDescription("Action to perform")
      .setRequired(true)
      .addChoices(
        { name: 'List Available', value: 'list' },
        { name: 'Enable Tool', value: 'enable' },
        { name: 'Disable Tool', value: 'disable' }
      )
  )
  .addStringOption(option =>
    option.setName("tool")
      .setDescription("Tool name (for enable/disable)")
      .setRequired(false)
  ),
```

#### B. Per-Channel Configuration

**Problem:** Currently all config is global (from config.json). Different channels might want different models or tool permissions.

**Solution:** Add channel-specific overrides:

```typescript
// New file: src/persistence/channel-config.ts
export interface ChannelConfig {
  model?: 'sonnet' | 'opus' | 'haiku';
  allowedTools?: string[];
  dangerousTools?: string[];
  autoApproveTools?: boolean;
}

export class ChannelConfigStore {
  private configs = new Map<string, ChannelConfig>();

  getConfig(channelId: string): ChannelConfig {
    return this.configs.get(channelId) || {};
  }

  setModel(channelId: string, model: 'sonnet' | 'opus' | 'haiku') {
    const config = this.getConfig(channelId);
    config.model = model;
    this.configs.set(channelId, config);
    this.save();
  }

  // ... similar methods for tools, etc.
}
```

**Usage in ai-client.ts:**
```typescript
// Merge global config with channel-specific overrides
const channelConfig = channelConfigStore.getConfig(this.channelId);
const options = {
  model: channelConfig.model || this.config.model,
  allowedTools: channelConfig.allowedTools || this.config.allowedTools,
  // ...
};
```

#### C. Guild-Level Command Registration

**Current:** Commands registered globally (visible in all servers)

**Option:** Register per-guild for faster updates during development

```typescript
// In slash-commands.ts
export async function registerCommands(
  token: string,
  clientId: string,
  guildId?: string  // Optional for guild-specific
): Promise<void> {
  const rest = new REST().setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, {
    body: commands.map((cmd) => cmd.toJSON()),
  });
}
```

**Note:** Guild commands update instantly, global commands take ~1 hour to propagate.

### Recommendation
1. **Keep existing slash command registration** (it's already correct)
2. **Add new commands**: `/model`, `/context`, `/export`, `/tools`
3. **Implement per-channel configuration** for model and tool settings
4. **Add `guildId` parameter** to config for development mode

### Files to Modify
- `src/bot/slash-commands.ts` - Add new command definitions and handlers
- `src/persistence/channel-config.ts` - **NEW FILE** for per-channel config
- `src/config.ts` - Add optional `guildId` field for dev mode
- `src/agent/ai-client.ts` - Use channel-specific config overrides

---

## 3. File Upload/Download & Image Support

### Current State
The bot currently has NO file handling capabilities:
- Cannot read user-uploaded images
- Cannot download files to show Claude
- Cannot send files back to Discord
- Text-only interaction

### Proposed Implementation

#### A. Image Upload Support

**Discord Message Attachments:**
Discord messages can have attachments accessible via `message.attachments` collection.

**Implementation Flow:**
```typescript
// In message-handler.ts
async handleMessage(message: Message): Promise<void> {
  // ... existing code ...

  // Check for attachments
  const imageAttachments = message.attachments.filter(att =>
    att.contentType?.startsWith('image/')
  );

  if (imageAttachments.size > 0) {
    // Download and process images
    const imageData = await this.processImageAttachments(imageAttachments);

    // Include in prompt context
    const enhancedPrompt = this.buildImagePrompt(cleanedContent, imageData);
    await this.sessionManager.queryAndStream(
      message.channelId,
      enhancedPrompt,
      updater
    );
  }
}

private async processImageAttachments(
  attachments: Collection<string, Attachment>
): Promise<ImageData[]> {
  const images: ImageData[] = [];

  for (const [id, attachment] of attachments) {
    if (!attachment.contentType?.startsWith('image/')) continue;

    try {
      // Download image
      const response = await fetch(attachment.url);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');

      images.push({
        name: attachment.name,
        contentType: attachment.contentType,
        base64Data: base64,
        size: attachment.size
      });

      console.log(`[IMG] Processed: ${attachment.name} (${attachment.size} bytes)`);
    } catch (error) {
      console.error(`[IMG] Failed to process ${attachment.name}:`, error);
    }
  }

  return images;
}
```

**Claude Vision Support:**
The Claude Agent SDK supports vision through message content blocks:

```typescript
// In ai-client.ts - modify query to accept images
async queryWithImages(
  prompt: string,
  images: ImageData[],
  resumeSessionId?: string
): Promise<string | null> {
  // Build content array with text + images
  const content = [
    { type: 'text', text: prompt }
  ];

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.contentType,
        data: img.base64Data
      }
    });
  }

  const options = {
    // ... existing options ...
    content: content  // Pass as structured content instead of simple prompt
  };

  // ... rest of query logic ...
}
```

**User Experience:**
1. User uploads image and types: "What's in this image?"
2. Bot downloads image from Discord CDN
3. Bot includes image in Claude API call
4. Claude analyzes image and responds
5. Bot streams response back to Discord

#### B. File Upload Support (Non-Images)

**Supported File Types:**
- `.txt`, `.md`, `.json`, `.yaml` - Text files (read directly)
- `.pdf` - PDF documents (extract text or use vision)
- `.zip` - Archives (extract and list contents)
- Source code files (`.py`, `.js`, `.ts`, etc.)

**Implementation:**
```typescript
// In message-handler.ts
private async processFileAttachments(
  attachments: Collection<string, Attachment>
): Promise<FileData[]> {
  const files: FileData[] = [];

  for (const [id, attachment] of attachments) {
    const ext = attachment.name.split('.').pop()?.toLowerCase();

    // Download file
    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();

    let content: string;

    // Handle different file types
    switch (ext) {
      case 'txt':
      case 'md':
      case 'json':
      case 'yaml':
      case 'yml':
      case 'py':
      case 'js':
      case 'ts':
        // Text files - read as UTF-8
        content = Buffer.from(buffer).toString('utf-8');
        break;

      case 'pdf':
        // PDF - extract text (need pdf-parse library)
        content = await this.extractPdfText(buffer);
        break;

      case 'zip':
        // Zip - extract and list
        content = await this.extractZipListing(buffer);
        break;

      default:
        content = `[Binary file: ${attachment.name}, ${attachment.size} bytes]`;
    }

    files.push({
      name: attachment.name,
      type: ext || 'unknown',
      content: content,
      size: attachment.size
    });
  }

  return files;
}

private buildFilePrompt(userPrompt: string, files: FileData[]): string {
  let prompt = userPrompt + '\n\n';

  for (const file of files) {
    prompt += `File: ${file.name}\n`;
    prompt += '```\n';
    prompt += file.content.slice(0, 50000); // Limit size
    prompt += '\n```\n\n';
  }

  return prompt;
}
```

#### C. File Download/Output Support

**Use Case:** Claude generates a file and user wants to download it.

**Approach 1: Automatic Attachment Detection**
Monitor tool use events and detect when files are created:

```typescript
// In chunked-updater.ts
onToolUse(toolName: string, toolInput: unknown): void {
  // ... existing code ...

  // Detect file creation
  if (toolName === 'Write' && toolInput.file_path) {
    this.pendingDownloads.add(toolInput.file_path);
  }
}

// After query completes in message-handler.ts
async finalize(): Promise<void> {
  await updater.finalize();

  // Check for pending downloads
  const downloads = updater.getPendingDownloads();
  if (downloads.length > 0) {
    await this.sendFilesAsAttachments(channel, downloads);
  }
}
```

**Approach 2: Slash Command**
Add `/download <filepath>` command:

```typescript
new SlashCommandBuilder()
  .setName("download")
  .setDescription("Download a file from the bot's workspace")
  .addStringOption(option =>
    option.setName("path")
      .setDescription("File path to download")
      .setRequired(true)
      .setAutocomplete(true) // Show recent files
  )
```

**Implementation:**
```typescript
// In slash-commands.ts
private async handleDownload(
  interaction: ChatInputCommandInteraction,
  channelId: string
): Promise<void> {
  const filePath = interaction.options.getString("path", true);

  // Validate file exists and is safe
  if (!this.isPathSafe(filePath)) {
    await interaction.reply({
      content: "Invalid or unsafe file path.",
      ephemeral: true
    });
    return;
  }

  try {
    const fs = await import('fs/promises');
    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    // Send as attachment
    const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });

    await interaction.reply({
      content: `Here's your file: **${fileName}**`,
      files: [attachment]
    });
  } catch (error) {
    await interaction.reply({
      content: `Failed to read file: ${error.message}`,
      ephemeral: true
    });
  }
}

private isPathSafe(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const cwd = process.cwd();

  // Ensure file is within bot's working directory
  return resolved.startsWith(cwd);
}
```

#### D. Size Limits & Constraints

**Discord Limits:**
- Free servers: 8 MB per file
- Nitro boosted (Level 2): 50 MB per file
- Nitro boosted (Level 3): 100 MB per file

**Claude API Limits:**
- Images: 5 MB per image (JPEG, PNG, GIF, WebP)
- Total prompt size: ~200k tokens (including image tokens)
- Image tokens: ~1360 tokens per image (depends on resolution)

**Implementation:**
```typescript
// In message-handler.ts
private validateAttachment(attachment: Attachment): boolean {
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  if (attachment.contentType?.startsWith('image/')) {
    if (attachment.size > MAX_IMAGE_SIZE) {
      return false;
    }
  } else {
    if (attachment.size > MAX_FILE_SIZE) {
      return false;
    }
  }

  return true;
}
```

### Recommendation
Implement in phases:

**Phase 1: Image Support (Priority)**
- Download image attachments from Discord
- Convert to base64
- Send to Claude Vision API
- Display results

**Phase 2: Text File Support**
- Support common text formats (.txt, .md, .json, .py, .js, etc.)
- Include file contents in prompt context
- Add file size limits

**Phase 3: File Output**
- Auto-detect file creation via tool monitoring
- Add `/download` command for manual downloads
- Send files as Discord attachments

**Phase 4: Advanced Formats**
- PDF text extraction
- Archive (zip) handling
- Binary file metadata display

### Files to Modify
- `src/bot/message-handler.ts` - Add attachment processing
- `src/agent/ai-client.ts` - Support image/file content in queries
- `src/streaming/chunked-updater.ts` - Track file creations for auto-download
- `src/bot/slash-commands.ts` - Add `/download` command
- `src/types/file-data.ts` - **NEW FILE** for type definitions
- `package.json` - Add dependencies: `pdf-parse`, `node-fetch` (if not present)

---

## Implementation Priority

### High Priority (Do First)
1. **Activity Status - Discord Presence** (Option A)
   - Quick win, high user value
   - ~2-3 hours implementation

2. **Image Upload Support** (Phase 1)
   - Enables vision capabilities
   - ~4-6 hours implementation

### Medium Priority (Do Next)
3. **Enhanced Terminal Logging** (Option C)
   - Helpful for debugging
   - ~1-2 hours implementation

4. **Text File Upload Support** (Phase 2)
   - Extends file capabilities
   - ~2-3 hours implementation

5. **New Slash Commands** (`/model`, `/context`)
   - Improves user control
   - ~3-4 hours implementation

### Low Priority (Nice to Have)
6. **Per-Channel Configuration**
   - Complex, requires persistence
   - ~4-6 hours implementation

7. **File Output/Download** (Phase 3)
   - Less commonly needed
   - ~3-4 hours implementation

8. **Advanced File Formats** (Phase 4)
   - PDF, zip support
   - ~4-6 hours implementation

---

## Testing Checklist

### Activity Status
- [ ] Presence updates when message received
- [ ] Presence shows "working" during tool use
- [ ] Presence shows "writing" during streaming
- [ ] Presence returns to "idle" after completion
- [ ] Terminal logs show detailed activity
- [ ] Multi-channel activity doesn't conflict

### Slash Commands
- [ ] Existing commands still work (`/clear`, `/status`, `/compact`)
- [ ] New commands appear in Discord UI
- [ ] `/model` changes model successfully
- [ ] `/context` shows accurate statistics
- [ ] Per-channel config persists across restarts
- [ ] Commands are registered within acceptable time

### Image Support
- [ ] Single image upload works
- [ ] Multiple images in one message work
- [ ] Images download successfully from CDN
- [ ] Base64 encoding is correct
- [ ] Claude receives and analyzes images
- [ ] Error handling for oversized images
- [ ] Supported formats: PNG, JPEG, GIF, WebP

### File Support
- [ ] Text files (.txt, .md) read correctly
- [ ] Code files (.py, .js, .ts) included in context
- [ ] JSON/YAML files parse properly
- [ ] File size limits enforced
- [ ] Multiple files in one message work
- [ ] Binary files handled gracefully

### File Download
- [ ] `/download` command lists available files
- [ ] File downloads as Discord attachment
- [ ] Path validation prevents directory traversal
- [ ] Auto-download detects Write tool usage
- [ ] File permissions respected
- [ ] Size limits enforced

---

## Dependencies to Add

```json
// In package.json
{
  "dependencies": {
    "pdf-parse": "^1.1.1",        // For PDF text extraction
    "node-fetch": "^3.3.2",        // For downloading attachments (if not present)
    "jszip": "^3.10.1"             // For zip file handling (Phase 4)
  },
  "devDependencies": {
    "@types/pdf-parse": "^1.1.1"
  }
}
```

---

## Configuration Changes

```json
// In config.json - add new optional fields
{
  "discordToken": "...",
  // ... existing fields ...

  // NEW: Optional guild ID for faster slash command registration during dev
  "guildId": "123456789",  // Remove for production (global registration)

  // NEW: File upload settings
  "fileUpload": {
    "enabled": true,
    "maxImageSize": 5242880,      // 5 MB
    "maxFileSize": 10485760,      // 10 MB
    "allowedExtensions": [".txt", ".md", ".json", ".py", ".js", ".ts", ".pdf"],
    "autoDownload": true           // Auto-send files created by Write tool
  },

  // NEW: Activity status settings
  "activityStatus": {
    "enabled": true,
    "updateInterval": 2000         // Update presence every 2s max
  }
}
```

---

## Security Considerations

### File Upload
- **Validate file types** before processing
- **Scan for malicious content** (e.g., JS in SVG files)
- **Limit file sizes** to prevent DoS
- **Sanitize file names** before saving
- **Don't execute uploaded files**

### File Download
- **Path traversal protection** - ensure paths stay within CWD
- **Permission checks** - verify bot created the file
- **Size limits** - enforce Discord's upload limits
- **Rate limiting** - prevent download spam

### Image Processing
- **Validate image headers** before processing
- **Re-encode images** to strip metadata (optional)
- **Limit dimensions** to prevent memory issues
- **Use secure image libraries**

---

## Performance Considerations

### Image Processing
- Download images **in parallel** when multiple attached
- Use **streams** instead of loading full buffer when possible
- **Cache downloaded images** temporarily (5 min TTL)
- **Compress large images** before sending to Claude if needed

### File Handling
- **Stream large files** instead of loading into memory
- **Implement pagination** for large zip listings
- **Set timeouts** for file operations
- **Clean up temp files** after processing

### Status Updates
- **Throttle presence updates** to avoid rate limits (max 5/min)
- **Batch terminal logs** to avoid console spam
- **Use single timer** for status updates across channels

---

## Future Enhancements

### Possible Additions
1. **Voice message transcription** (via Whisper API)
2. **Embed generation** for formatted responses
3. **Conversation export** to HTML/PDF
4. **Multi-user collaboration** in same channel
5. **Reaction-based shortcuts** (👍 to approve all tools, ❌ to cancel)
6. **Thread support** for long conversations
7. **Code syntax highlighting** in responses
8. **Inline code execution** with output display

---

## Migration Path

### For Existing Installations

1. **Backup existing sessions**: `cp data/sessions.json data/sessions.backup.json`
2. **Pull new code** with changes
3. **Run `npm install`** to get new dependencies
4. **Update config.json** with new optional fields
5. **Restart bot** - sessions will be preserved
6. **Test slash commands** in a dev channel
7. **Test image upload** with a sample image
8. **Monitor logs** for any issues

### Rollback Plan
If issues occur:
1. Stop bot
2. `git checkout <previous-commit>`
3. Restore sessions: `cp data/sessions.backup.json data/sessions.json`
4. `npm install` (restore old deps)
5. Restart bot

---

## Questions for User

Before implementation, please clarify:

1. **Activity Status**: Do you prefer:
   - Option A: Bot presence status (global, simple)
   - Option B: Per-channel status messages (detailed, cluttered)
   - Option A + C: Presence + enhanced terminal logs (recommended)

2. **Slash Commands**: Which new commands are most valuable?
   - `/model` - Change model per channel
   - `/context` - Show context stats
   - `/export` - Export conversation
   - `/tools` - Manage tool permissions
   - All of the above?

3. **File Upload**: Which file types should be prioritized?
   - Images only (fastest to implement)
   - Images + text files (.txt, .md, .json, code)
   - Images + text + PDFs
   - All of the above including archives

4. **File Download**: Preferred approach?
   - Auto-download files created by Write tool (automatic)
   - Manual `/download` command only (on-demand)
   - Both (recommended)

5. **Security**: Should there be admin-only commands?
   - e.g., `/tools enable Bash` only for server admins
   - Or allow any user to configure their channel?

6. **Deployment**:
   - Is this for a single private server (use guild-specific commands)?
   - Or multiple servers (use global command registration)?
