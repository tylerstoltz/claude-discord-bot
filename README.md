# Claude Discord Bot (SDK Edition)

A Discord bot that gives Claude Code full autonomous control of a machine, using Discord as the UI for human-in-the-loop communication.

## Features

- **Persistent Sessions**: Conversations persist across bot restarts (per-channel based)
- **Permission Approval via Discord**: Dangerous operations require approval via interactive buttons + reaction fallback
- **Chunked Streaming**: Real-time updates as Claude works, with smart message editing and rate-limit handling
- **Slash Commands**: `/compact` and `/clear` for session management
- **Full Agent Control**: Claude can use all tools (Bash, Read, Write, Edit, etc.)
- **Dual Interaction System**: Both modern buttons and classic reactions for maximum compatibility
- **Image Support**: Send images to Claude for analysis (drag & drop in Discord)
- **File Uploads**: Claude can upload files it creates OR arbitrary files you ask for to Discord
- **Playground Skills**: Auto-discovers skills from `playground/` subdirectories at startup (iMessage, ALDI prices, etc.)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure the bot:**
   Edit `config.json`:
   ```json
   {
     "discordToken": "YOUR_DISCORD_BOT_TOKEN",
     "monitorMentions": true,
     "monitorAllMessages": false,
     "allowedChannels": [],
     "model": "sonnet"
   }
   ```

3. **Run the bot:**
   ```bash
   npm start
   ```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `discordToken` | `""` | Discord bot token (required) |
| `monitorMentions` | `true` | Respond to @mentions |
| `monitorAllMessages` | `false` | Respond to all messages in allowed channels |
| `allowedChannels` | `[]` | Channel IDs to monitor (empty = all) |
| `model` | `"sonnet"` | Claude model: sonnet, opus, haiku |
| `allowedTools` | `[...]` | Tools Claude can use |
| `dangerousTools` | `["Bash", "Write", "Edit", "MultiEdit"]` | Tools requiring Discord approval |
| `updateIntervalMs` | `3000` | How often to update messages (ms) |
| `permissionTimeoutMs` | `60000` | Permission request timeout (ms) |

## Slash Commands

- `/compact` - Show conversation context info (message count, auto-compaction status)
- `/clear` - Clear session and start fresh
- `/status` - Show session info
- `/rewind [count]` - Rewind conversation by removing recent messages (like ESC-ESC in CLI)

## Session Management

### Per-Channel Sessions
- Each Discord channel maintains its own independent AI conversation
- Multiple users in the same channel share the same conversation context
- Different channels are completely isolated from each other
- Sessions persist to disk (`data/sessions.json`) and survive bot restarts
- **Message history tracking** enables rewind functionality

### Session Lifecycle
```
First message in channel → Create new session → Get SDK session ID
Subsequent messages     → Resume with existing session ID
Bot restart             → Load persisted sessions from disk
/clear command          → Wipe session for that channel
/rewind [count]         → Rollback conversation by N message exchanges
```

### Session Commands in Detail

#### `/compact`
Shows information about the current conversation context:
- Message count in history
- Explains SDK auto-compaction behavior
- Suggests alternatives (`/clear` or `/rewind`)

The Claude Agent SDK automatically compacts context when it grows large, so this command primarily provides visibility into the session state rather than triggering compaction.

#### `/rewind [count]`
Rewinds the conversation by removing recent message exchanges:
- **Usage**: `/rewind` (removes last message) or `/rewind 5` (removes last 5 messages)
- **Range**: 1-50 messages
- **Behavior**:
  - Removes specified number of message exchanges from history
  - Updates session to earlier state
  - If rewound to beginning, starts fresh conversation
- **Similar to**: Pressing ESC twice in Claude Code CLI
- **Use case**: Undo a mistake, try a different approach, or free up context

#### `/clear`
Complete session reset:
- Deletes SDK session file from disk (`~/.claude/projects/...`)
- Clears all message history
- Re-scans playground skills and `CLAUDE.local.md` so new additions take effect immediately
- Next message starts a completely fresh conversation

## Chunked Streaming Response

The bot uses smart message editing to provide real-time updates:

### How it Works
1. **Initial Reply**: Bot replies to your message with streaming content
2. **Live Updates**: Same message is edited every ~3 seconds with new content
3. **Tool Indicators**: Shows immediately when Claude uses a tool (Read, Bash, etc.)
4. **Rate Limiting**:
   - Exponential backoff on Discord rate limits (1s → 2s → 4s...)
   - Queues updates if editing is in progress
5. **Finalization**:
   - Content ≤2000 chars: Single final edit
   - Content >2000 chars: Splits into multiple messages

### Visual Indicators
- `⏳` reaction: Bot is busy processing another request
- **> Using: `ToolName`** - Shows which tool Claude is using in real-time

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

### Approval Flow
1. Claude requests dangerous operation (e.g., `Bash` command)
2. Bot sends orange-colored embed with:
   - Tool name and JSON input preview
   - Both interactive buttons AND emoji reactions
   - Countdown timer in footer
3. User responds via button click OR emoji reaction
4. Embed updates with result:
   - 🟢 Green = Approved
   - 🔴 Red = Denied
   - ⚪ Gray = Timeout (auto-deny after 60 seconds)
5. Claude continues or stops based on decision

## Discord Features Used

The bot leverages these Discord.js capabilities:

### Messages
- `message.reply()` - Reply to user messages
- `message.edit()` - Edit messages for live streaming updates
- `channel.send()` - Send follow-up messages
- `channel.sendTyping()` - Show "bot is typing..." indicator

### Reactions & Emojis
- `message.react(emoji)` - Add reactions (⏳ for busy, ✅/❌ for approvals)
- Listen to `MessageReactionAdd` events for user reactions

### Rich Embeds
- `EmbedBuilder` - Formatted messages with colors, fields, timestamps
- Color-coded approval states (orange → green/red/gray)

### Interactive Components
- `ButtonBuilder` - Clickable buttons (Success/Danger styles)
- `ActionRowBuilder` - Container for button groups
- Button interaction handling via `InteractionCreate` events

### Slash Commands
- `/clear`, `/compact`, `/status`, `/rewind` registered globally
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
  MessageHandler (should respond?)
       ↓
  SessionManager (per-channel session lookup)
       ↓
  AIClient (Claude Agent SDK)
       ↓
  PermissionHook ←→ Discord (buttons + reactions)
       ↓
  ChunkedUpdater (streaming with smart editing)
       ↓
  Discord Reply (live edits every 3s, then finalize)
```

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
├── index.ts                 # Entry point
├── config.ts               # Configuration loader
├── bot/
│   ├── discord-client.ts   # Discord.js client
│   ├── message-handler.ts  # Message processing
│   └── slash-commands.ts   # /compact, /clear, /status, /rewind
├── agent/
│   ├── ai-client.ts        # Claude Agent SDK wrapper + skill discovery
│   ├── session-manager.ts  # Session persistence
│   └── permission-hook.ts  # PreToolUse approval via Discord
├── streaming/
│   ├── chunked-updater.ts  # Batched message updates
│   └── message-splitter.ts # 2000 char limit handling
└── persistence/
    └── session-store.ts    # Session ID persistence
```

## Requirements

- Node.js 18+
- Discord bot with MESSAGE_CONTENT intent
- Claude Code installed and authenticated (`claude login`)

## Notes

- **No API key required** if Claude Code is authenticated via subscription
- Sessions are stored in `data/sessions.json`
- Bot requires MESSAGE_CONTENT intent in Discord Developer Portal
- **`CLAUDE.local.md`** — Optional gitignored file for deployment-specific context (GitHub identity, SSH keys, etc.) that gets injected into the system prompt alongside `CLAUDE.md`. Use this for private config that shouldn't be checked into the repo.
