# Claude Discord Bot (SDK Edition)

A Discord bot that gives Claude Code full autonomous control of a machine, using Discord as the UI for human-in-the-loop communication.

## Features

- **Persistent Sessions**: Conversations persist across bot restarts
- **Permission Approval via Discord**: Dangerous operations (Bash, Write, Edit) require approval via Discord buttons
- **Chunked Streaming**: Real-time updates as Claude works, with message editing instead of spam
- **Slash Commands**: `/compact` and `/clear` for session management
- **Full Agent Control**: Claude can use all tools (Bash, Read, Write, Edit, etc.)

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

- `/compact` - Summarize current context (keeps session)
- `/clear` - Clear session and start fresh
- `/status` - Show session info

## Permission Flow

When Claude wants to run a dangerous tool (Bash, Write, Edit):

1. Bot sends an embed with the command details
2. User clicks **Approve** or **Deny** buttons
3. Claude proceeds or stops based on the decision
4. 60-second timeout defaults to deny

## Architecture

```
Discord Message
       ↓
  MessageHandler (should respond?)
       ↓
  SessionManager (get/create session)
       ↓
  AIClient (Claude Agent SDK)
       ↓
  PermissionHook ←→ Discord (approval)
       ↓
  ChunkedUpdater (streaming response)
       ↓
  Discord Reply (with edits)
```

## Files

```
src/
├── index.ts                 # Entry point
├── config.ts               # Configuration loader
├── bot/
│   ├── discord-client.ts   # Discord.js client
│   ├── message-handler.ts  # Message processing
│   └── slash-commands.ts   # /compact, /clear, /status
├── agent/
│   ├── ai-client.ts        # Claude Agent SDK wrapper
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
