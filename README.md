# Claude Discord Bot (SDK Edition)

A Discord bot that gives Claude Code full autonomous control of a machine, using Discord as the UI for human-in-the-loop communication.

## Features

- **Access Control**: Only allowlisted Discord users can talk to the bot, run slash commands, or approve tools
- **Persistent Sessions**: Conversations persist across bot restarts (per-channel based)
- **Permission Approval via Discord**: Dangerous operations require approval via interactive buttons + reaction fallback
- **Chunked Streaming**: Real-time updates as Claude works; long replies roll over into new messages as they stream
- **Message Queue**: Messages sent while Claude is busy are queued (⏳) and answered in order
- **Slash Commands**: `/status`, `/clear`, `/compact`, `/rewind` for session management
- **Full Agent Control**: Claude can use all tools (Bash, Read, Write, Edit, etc.)
- **Dual Interaction System**: Both modern buttons and classic reactions for maximum compatibility
- **Image Support**: Send images to Claude for analysis (drag & drop in Discord, with or without text)
- **File Uploads**: Claude can upload files it creates, or files you ask for, from allowed directories
- **Discord Tools**: Claude can read message history, list channels, and search messages (scoped to allowed channels)
- **Playground Skills**: Auto-discovers skills from `playground/` subdirectories at startup (iMessage, ALDI prices, etc.)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure the bot:**
   Copy `config.example.json` to `config.json` and edit it:
   ```json
   {
     "discordToken": "YOUR_DISCORD_BOT_TOKEN",
     "allowedUsers": ["YOUR_DISCORD_USER_ID"],
     "monitorMentions": true,
     "monitorAllMessages": false,
     "allowedChannels": [],
     "model": "sonnet"
   }
   ```
   To find your user ID: Discord → Settings → Advanced → enable Developer Mode, then right-click your name → Copy User ID.

3. **Run the bot:**
   ```bash
   npm start
   ```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `discordToken` | `""` | Discord bot token (required) |
| `allowedUsers` | `[]` | Discord user IDs allowed to use the bot and approve tools. **Empty = anyone** (a warning is logged at startup) |
| `monitorMentions` | `true` | Respond to @mentions |
| `monitorAllMessages` | `false` | Respond to all messages in allowed channels |
| `allowedChannels` | `[]` | Channel IDs to monitor (empty = all). Threads inherit their parent channel |
| `guildId` | – | Server ID for instant slash command registration; also the default server for Discord tools |
| `model` | `"sonnet"` | Claude model: sonnet, opus, haiku |
| `enableChrome` | `false` | Give Claude the Chrome browser tool |
| `allowedTools` | `[...]` | Tools Claude can use |
| `dangerousTools` | `["Bash", "Write", "Edit", "MultiEdit"]` | Tools requiring Discord approval |
| `updateIntervalMs` | `3000` | How often to update messages (ms) |
| `permissionTimeoutMs` | `60000` | Permission request timeout (ms) |
| `maxQueuedMessages` | `5` | Messages that can wait per channel while Claude is busy |
| `fileUpload.allowedDirs` | `["./playground"]` | Directories files may be uploaded from (empty = anywhere) |
| `fileUpload.allowedExtensions` | `[...]` | File types that may be uploaded |
| `logLevel` | `"info"` | `debug`, `info`, `warn`, or `error` |

Nested sections (`attachments`, `fileUpload`) can be partially overridden; unspecified keys keep their defaults.

## Security Model

The bot runs Claude with real tool access on the host, so who can reach it matters:

- **`allowedUsers`** gates everything: messages from other users are ignored, their slash commands are refused, and their button clicks or reactions on approval requests are ignored. Set it.
- **`allowedChannels`** limits where the bot listens, where slash commands work, and which channels the Discord tools can read.
- **Dangerous tools** (`dangerousTools`) need an explicit approval in Discord. Read-only tools (Read, Grep, WebFetch, ...) do not, so anyone in `allowedUsers` can ask Claude to read files on the host.
- **File uploads** only come from `fileUpload.allowedDirs`. Symlinks are resolved first, and the bot's own secrets (`config.json`, `CLAUDE.local.md`, `data/sessions.json`, `.env*`) are never uploaded.
- **`CLAUDE.local.md`** is *not* put in the system prompt. Claude is told it exists and reads it on demand.
- **Host settings are isolated**: the SDK runs with `settingSources: []`, so your personal `~/.claude/settings.json` permissions and hooks don't apply to the bot.

## Slash Commands

- `/status` - Show session info (session ID, queue, rewindable exchanges)
- `/clear` - Clear session and start fresh
- `/compact` - Summarize the conversation to free up context
- `/rewind [count]` - Rewind the conversation by removing recent exchanges (like ESC-ESC in the CLI)

Slash commands follow the same `allowedUsers` / `allowedChannels` rules as messages.

## Session Management

### Per-Channel Sessions
- Each Discord channel maintains its own independent AI conversation
- Multiple users in the same channel share the same conversation context
- Different channels are completely isolated from each other and run concurrently
- Within a channel, messages are handled one at a time; extras are queued (⏳) up to `maxQueuedMessages`
- Sessions persist to disk (`data/sessions.json`, written atomically) and survive bot restarts

### Session Lifecycle
```
First message in channel → Create new session → Get SDK session ID
Subsequent messages     → Resume with existing session ID
Each completed exchange → Record the transcript point it ended at (for /rewind)
Bot restart             → Load persisted sessions from disk (before connecting)
/clear command          → Stop any running reply, delete the SDK transcript, wipe the session
/rewind [count]         → Next message resumes from N exchanges back
/compact                → SDK summarizes the conversation in place
```

### Session Commands in Detail

#### `/compact`
Runs the SDK's `/compact` on the channel's session: the conversation is replaced by a summary, freeing context. It waits for any reply in progress. Reports token counts before and after. Earlier exchanges can't be rewound after compacting.

The SDK also compacts automatically when context grows large.

#### `/rewind [count]`
Rewinds the conversation by removing recent exchanges:
- **Usage**: `/rewind` (removes the last exchange) or `/rewind 5` (removes the last 5)
- **Range**: 1-50 exchanges
- **Behavior**:
  - Stops any reply in progress (a partial exchange counts as one)
  - The next message resumes the SDK session at the end of the kept exchange (`resumeSessionAt`), so Claude no longer sees the removed ones
  - Rewinding past the first exchange starts a fresh conversation
- **Similar to**: Pressing ESC twice in Claude Code CLI
- **Note**: Rewind only changes the conversation. Files Claude created or edited stay as they are.

#### `/clear`
Complete session reset:
- Stops any reply in progress
- Deletes the SDK session transcript from disk (`~/.claude/projects/<project>/<session>.jsonl`)
- Re-reads `CLAUDE.md` and re-scans playground skills so changes take effect immediately
- Next message starts a completely fresh conversation

## Chunked Streaming Response

The bot uses smart message editing to provide real-time updates:

### How it Works
1. **Initial Reply**: Bot replies to your message with streaming content
2. **Live Updates**: The message is edited every ~3 seconds with new content
3. **Tool Indicators**: Shows immediately when Claude uses a tool (Read, Bash, etc.)
4. **Rollover**: When a reply outgrows Discord's 2000-char limit, the current message is finished at a natural break (paragraph, line, sentence) and streaming continues in a new message. Code blocks split across messages are closed and reopened with their language.
5. **Rate Limiting**: Handled by discord.js; renders are serialized so edits never overlap
6. **Finalization**: The final text is rendered once more, then files are uploaded
7. **Status notes**: If Claude hits the turn limit, errors, or is stopped by `/clear`/`/rewind`, a note is added to the end of the reply

### Visual Indicators
- `⏳` reaction: Your message is queued behind another request (removed when it starts)
- **> Using: `ToolName`** - Shows which tool Claude is using in real-time

## File Uploads

- **Automatic**: Files Claude writes with the `Write` tool are uploaded when the reply finishes. Only successful writes count: a denied or failed write is not uploaded.
- **On request**: Claude can include `[UPLOAD: /path/to/file]` in its reply to upload an existing file.
- Both are limited to `fileUpload.allowedDirs` (default `./playground`), `allowedExtensions`, and `maxFileSize`. Bot secrets are always blocked.

## Permission Approval System

When Claude wants to run a dangerous tool (Bash, Write, Edit), a dual approval system is used:

### Approval Embed (Both Methods Work)
1. **Interactive Buttons** (Primary):
   - ✅ **Approve** button (green)
   - ❌ **Deny** button (red)
   - Click once, buttons disappear after decision

2. **Emoji Reactions** (Fallback):
   - ✅ checkmark reaction
   - ❌ X reaction
   - Click emoji to approve/deny

Only users in `allowedUsers` can approve or deny. Anyone else gets an ephemeral "not authorized" reply.

### Approval Flow
1. Claude requests dangerous operation (e.g., `Bash` command)
2. Bot sends orange-colored embed with:
   - Tool name and JSON input preview
   - Both interactive buttons AND emoji reactions
   - Countdown timer in footer
3. An authorized user responds via button click OR emoji reaction
4. Embed updates with result (and who decided):
   - 🟢 Green = Approved
   - 🔴 Red = Denied
   - ⚪ Gray = Timeout (auto-deny after 60 seconds) or cancelled (reply stopped)
5. On approval the tool runs. On denial Claude is told the user said no, and can explain or try another approach. The reply keeps going.

## Discord Tools (MCP)

Claude gets four in-process tools for reading Discord:

| Tool | Description |
|------|-------------|
| `discord_fetch_messages` | Recent messages in a channel or thread (paginate with `before_message_id`) |
| `discord_search_messages` | Keyword search over recent messages (paginate with `before_message_id`) |
| `discord_list_channels` | Channels in the server |
| `discord_server_info` | Server name, members, roles, owner |

When `allowedChannels` is set, these tools can only read (and only list) those channels and their threads. They default to the `guildId` server.

## Discord Features Used

The bot leverages these Discord.js capabilities:

### Messages
- `message.reply()` - Reply to user messages
- `message.edit()` - Edit messages for live streaming updates
- `channel.send()` - Send follow-up messages
- `channel.sendTyping()` - Show "bot is typing..." indicator

### Reactions & Emojis
- `message.react(emoji)` - Add reactions (⏳ for queued, ✅/❌ for approvals)
- Listen to `MessageReactionAdd` events for user reactions

### Rich Embeds
- `EmbedBuilder` - Formatted messages with colors, fields, timestamps
- Color-coded approval states (orange → green/red/gray)

### Interactive Components
- `ButtonBuilder` - Clickable buttons (Success/Danger styles)
- `ActionRowBuilder` - Container for button groups
- Button interaction handling via `InteractionCreate` events

### Slash Commands
- `/clear`, `/compact`, `/status`, `/rewind`, registered per-guild (`guildId`) or globally
- Chat input command handling with parameter support

### Required Intents
```javascript
GatewayIntentBits.Guilds              // Server info
GatewayIntentBits.GuildMessages       // Read messages
GatewayIntentBits.MessageContent      // Access message text (privileged!)
GatewayIntentBits.GuildMessageReactions // See reactions
```

## Architecture

```
Discord Message
       ↓
  MessageHandler (allowed user/channel? queue per channel)
       ↓
  SessionManager (per-channel session, queue, rewind point)
       ↓
  AIClient (Claude Agent SDK query)
       ↓
  PermissionHook ←→ Discord (buttons + reactions)
       ↓
  ChunkedUpdater (streaming with rollover) + FileUploadManager (per reply)
       ↓
  Discord Reply (live edits every 3s, then finalize + uploads)
```

Event handlers are wrapped so a Discord API error is logged instead of crashing the process.

## Playground Skills

The `playground/` directory contains skills — self-contained tools that Claude can use autonomously. Skills are **auto-discovered** at startup and **refreshed on `/clear`**: each subdirectory with a `SKILL.md` file is indexed and injected into the system prompt.

### How It Works

1. At startup (and on `/clear`), `ai-client.ts` scans `playground/*/` for `SKILL.md` or `skill.md` files
2. YAML frontmatter (`name` + `description`) is parsed from each file
3. A compact skill index (~100 tokens per skill) is appended to the system prompt
4. When a user's request matches a skill description, Claude reads the full `SKILL.md` on-demand

### Adding a New Skill

1. Create a directory: `playground/my-skill/`
2. Create `playground/my-skill/SKILL.md`:
   ```yaml
   ---
   name: my-skill
   description: What this skill does and when to use it.
   ---

   # My Skill

   Instructions for Claude to follow...
   ```
3. Run `/clear` (or restart the bot) — the skill is auto-discovered, no other files to edit

### Included Skills

| Skill | Description |
|-------|-------------|
| `imessage` | Send and read iMessages via AppleScript and SQLite |
| `aldi-prices` | Search ALDI US product prices and availability |
| `4claw` | Post to 4claw, a moderated imageboard for AI agents |

> **Note:** `playground/archive/` and `playground/scratchpad/` are excluded from discovery.

## Files

```
src/
├── index.ts                   # Entry point
├── config.ts                  # Configuration loader + access helpers
├── bot/
│   ├── discord-client.ts      # Discord.js client + guarded event handlers
│   ├── message-handler.ts     # Message filtering, queueing, response orchestration
│   ├── slash-commands.ts      # /compact, /clear, /status, /rewind
│   └── activity-manager.ts    # Bot presence (Idle/Thinking/Working/Writing)
├── agent/
│   ├── ai-client.ts           # Claude Agent SDK wrapper + skill discovery
│   ├── session-manager.ts     # Sessions, per-channel queue, rewind, compact, clear
│   └── permission-hook.ts     # PreToolUse approval via Discord
├── attachments/
│   ├── image-processor.ts     # Discord image → base64 content block
│   └── file-upload-manager.ts # Claude → Discord file uploads
├── discord/
│   └── discord-mcp-server.ts  # Discord read tools for Claude
├── streaming/
│   ├── chunked-updater.ts     # Streaming message updates with rollover
│   └── message-splitter.ts    # Fence-aware 2000-char splitting
└── persistence/
    └── session-store.ts       # Session + rewind-point persistence
test/                          # node:test suite (npm test)
```

## Development

```bash
npm run dev        # Auto-reload (tsx watch)
npm test           # Unit tests (node:test via tsx)
npm run typecheck  # tsc --noEmit
```

## Requirements

- Node.js 18+
- Discord bot with MESSAGE_CONTENT intent
- Claude Code authenticated (`claude login`). The Claude binary itself comes with the SDK's platform package, installed by `npm install`.

## Bot-to-Bot Interaction

By default, the bot **ignores messages from other bots** (including other AI bots like CodexAgent). This is controlled by the `message.author.bot` check in `shouldRespond()` in `src/bot/message-handler.ts`:

```typescript
if (message.author.id === this.botUserId || message.author.bot) {
  return false;
}
```

### Enabling bot-to-bot replies

To allow the bot to respond when another bot @mentions it, remove or gate that check. To make it configurable, add a `respondToBots` option:

1. Add to `BotConfig` in `src/config.ts`:
   ```typescript
   respondToBots: boolean;
   ```
2. Add the default in the `defaultConfig` object:
   ```typescript
   respondToBots: false,
   ```
3. Update `shouldRespond()` in `src/bot/message-handler.ts`:
   ```typescript
   if (message.author.id === this.botUserId || (message.author.bot && !this.config.respondToBots)) {
     return false;
   }
   ```
4. Set `"respondToBots": true` in your `config.json`, and add the other bot's user ID to `allowedUsers` if you use an allowlist.

**Warning:** If two bots both have this enabled and are in the same channel, they can enter an infinite reply loop. Add safeguards such as a cooldown, a max reply chain depth, or an allowlist of bot IDs to respond to.

## Notes

- **No API key required** if Claude Code is authenticated via subscription
- Sessions are stored in `data/sessions.json`
- Bot requires MESSAGE_CONTENT intent in Discord Developer Portal
- **`CLAUDE.local.md`** — Optional gitignored file for deployment-specific context (GitHub identity, SSH keys, etc.). Claude is told it exists and reads it when a task needs it; its contents are not injected into the system prompt.

## Upgrading from older versions

- Run `npm install`: the Claude Agent SDK moved from 0.1.x to 0.3.x (which also needs zod 4).
- Add your user ID to `allowedUsers` in `config.json`.
- Uploads now only come from `./playground` by default. Set `fileUpload.allowedDirs` if Claude writes files elsewhere.
- `/rewind` history recorded by older versions was not usable and is dropped on load; rewinding works for exchanges from after the upgrade.
