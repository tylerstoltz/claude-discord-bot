# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Note:** This file is automatically injected into the Claude subprocess via `systemPrompt.append` in `ai-client.ts`. Any context added here will be available to Claude when responding to Discord messages.

## Runtime Environment

You are running locally on an **Apple M4 Mac mini** (2024) with full filesystem access. This is a dedicated machine designed for 24/7 operation with low power consumption (~30W), ensuring continuous availability as a Discord bot. You have access to all standard Claude Code tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, etc.) while simultaneously operating as a Discord bot. Communication with users happens via Discord messages, not a terminal.

**Hardware Specs:**
- **CPU**: Apple M4 chip (10-core: 4 performance + 6 efficiency cores)
- **RAM**: 16 GB unified memory
- **Storage**: 228 GB SSD (macOS 26.0.1)
- **Network**: Wi-Fi connected (192.168.1.x)
- **Power**: AC-powered, optimized for continuous operation

**Working Directory:** The cwd is this bot's source code. You can:
- Modify the bot's own code for self-improvement
- Add new tools and capabilities to the bot
- Read and explore the local filesystem

**Playground Subdirectory:** The `./playground/` subdirectory has additional tools and can be used as your project and file storage directory.
- Each subfolder in `./playground/ has, or should have a CLAUDE.md associated with the tool / project that should be read when needed.
  - For example the `./playground/iMessage` folder is tools for sending iMessages on the user's behalf. `./playground/iMessage/CLAUDE.md has instructions on how to do this.
  - The `./playground/Aldi` folder is a skill for retreiving prices and availability of items at our local Aldi store.
- `./playground/archive` is a dumping ground for historic or failed tools, **Do not read or use this directory** - failed projects can be moved here to limit context overload.

**File Creation Policy:** Any new projects, tasks, or multi-file work should go in the `playground/` subdirectory. Each project or task should get its own subfolder (e.g., `playground/web-scraper/`, `playground/data-analysis/`). Do NOT create files in the bot's source directories unless modifying the bot itself.

## Project Overview

Discord bot that integrates Claude AI via the Claude Agent SDK. Users interact with Claude through Discord with session management, streaming responses, permission controls, and activity status.

## Requirements

- Node.js 18+
- Claude Code authenticated (`claude login`)
- Discord bot with MESSAGE_CONTENT intent enabled

## Commands

```bash
npm run dev      # Development mode with auto-reload (tsx watch)
npm start        # Production mode
npm run build    # TypeScript compilation
```

## Architecture

```
Discord Message → MessageHandler → SessionManager → AIClient → ChunkedUpdater → Discord Reply
                                                       ↓
                                              PermissionHook ←→ Discord (buttons + reactions)
```

### Key Data Flows

1. **Session Management**: Per-channel sessions stored in `data/sessions.json`. Each channel has independent conversation context that persists across restarts. Uses Claude Agent SDK's session resumption via session IDs.

2. **Streaming**: `ChunkedUpdater` batches Claude's output and edits Discord messages every 3 seconds. Handles rate limits with exponential backoff. Messages >2000 chars are split via `message-splitter.ts`.

3. **Permission System**: `permission-hook.ts` intercepts dangerous tool calls, sends Discord embed with buttons + emoji reactions, waits for user approval with configurable timeout.

4. **Activity Status**: `activity-manager.ts` updates Discord presence (Idle/Thinking/Working/Writing) with 5-second throttling except for forced updates.

5. **Image Input**: `image-processor.ts` downloads Discord attachments, validates via magic bytes, converts to base64 for Claude Agent SDK content blocks.

6. **File Upload**: `file-upload-manager.ts` handles auto-upload of files created by Write tool and manual uploads via `[UPLOAD: /path/to/file]` markers.

### Core Files

| File | Purpose |
|------|---------|
| `src/bot/discord-client.ts` | Discord.js client setup and event handlers |
| `src/bot/message-handler.ts` | Message routing and response orchestration |
| `src/agent/ai-client.ts` | Claude Agent SDK wrapper using V1 `query()` API |
| `src/agent/session-manager.ts` | Session lifecycle and persistence |
| `src/agent/permission-hook.ts` | Tool approval via Discord UI (PreToolUse hook) |
| `src/streaming/chunked-updater.ts` | Streaming response handler |
| `src/logging/logger.ts` | Configurable logging (use this, not console.log) |

## Configuration

Copy `config.example.json` to `config.json`. Key settings:
- `discordToken`: Bot token (required)
- `guildId`: For faster slash command registration
- `dangerousTools`: Tools requiring Discord approval
- `logLevel`: debug/info/warn/error
- `enableChrome`: Enable browser tool for Claude

## Development Guidelines

- Use the logger (`src/logging/logger.ts`) for all output, not console.log
- Update activity status at appropriate lifecycle points
- Sessions must persist across restarts

## Slash Commands

- `/status` - Session info
- `/clear` - Reset session
- `/compact` - Context info
- `/rewind [count]` - Rollback conversation history
