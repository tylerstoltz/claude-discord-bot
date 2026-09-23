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

**Playground Subdirectory:** The `./playground/` subdirectory contains skills, tools, and projects.
- Available skills are auto-discovered at startup and listed in the skill index appended below.
- Each skill has a SKILL.md with instructions. ALWAYS read it BEFORE attempting related tasks.
- `./playground/archive` is for historic or failed tools. **Do not read or use this directory.**

**File Creation Policy:** Any new projects, tasks, or multi-file work should go in the `playground/` subdirectory. Each project or task should get its own subfolder (e.g., `playground/web-scraper/`, `playground/data-analysis/`). Do NOT create files in the bot's source directories unless modifying the bot itself.

**Sending Files to Discord:** Files you create with the Write tool are uploaded automatically when your reply finishes. To send an existing file, put `[UPLOAD: /path/to/file]` in your reply. Uploads only work for files inside `playground/` (unless `fileUpload.allowedDirs` says otherwise) with an allowed extension; save files there if the user should receive them. The bot's secret files (`config.json`, `CLAUDE.local.md`, `data/sessions.json`, `.env*`) are never uploaded. Never paste their contents into a reply either.

## Project Overview

Discord bot that integrates Claude AI via the Claude Agent SDK. Users interact with Claude through Discord with session management, streaming responses, permission controls, and activity status.

## Requirements

- Node.js 18+
- Claude Code authenticated (`claude login`)
- Discord bot with MESSAGE_CONTENT intent enabled

## Commands

```bash
npm run dev        # Development mode with auto-reload (tsx watch)
npm start          # Production mode
npm test           # Unit tests (node:test via tsx, in test/)
npm run typecheck  # tsc --noEmit
npm run build      # TypeScript compilation
```

## Architecture

```
Discord Message → MessageHandler → SessionManager → AIClient → ChunkedUpdater → Discord Reply
  (access checks,    (per-channel     (SDK query)      ↓            ↓
   queueing)          queue, rewind)          PermissionHook   FileUploadManager (per reply)
                                              ←→ Discord (buttons + reactions)
```

### Key Data Flows

1. **Access Control**: `config.ts` has `isUserAllowed` / `isChannelAllowed`. `allowedUsers` gates messages, slash commands, and approval clicks/reactions. `allowedChannels` gates where the bot listens and which channels the Discord MCP tools can read (threads inherit their parent).

2. **Session Management**: Per-channel sessions stored in `data/sessions.json` (atomic write). Each channel has independent conversation context that persists across restarts, via the SDK's `resume`. Work in a channel runs through `SessionManager.runExclusive` (one at a time, extras queued with ⏳ up to `maxQueuedMessages`); different channels run concurrently.

3. **Rewind**: After each exchange, the UUID of its last main-chain transcript entry is recorded (`turns` in the store). `/rewind N` drops N of them and sets `resumeAt`; the next query passes it as `resumeSessionAt`. `/compact` runs the SDK's `/compact` prompt and clears `turns`. `/clear` aborts the running query, waits for it, and deletes `~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl`.

4. **Streaming**: `ChunkedUpdater` renders at most every `updateIntervalMs` through a serialized render chain. When the text exceeds 2000 chars the current message is finished at a natural break (`takeChunk` in `message-splitter.ts`, which keeps ``` fences balanced) and a new message continues it. Nothing renders after `finalize()`.

5. **Permission System**: `permission-hook.ts` is a PreToolUse hook for `dangerousTools`. It posts an embed with buttons + reactions and waits for an allowed user, the timeout, or the query's abort signal. Denials do not set `continue: false`, so Claude sees the reason and the turn continues.

6. **Activity Status**: `activity-manager.ts` updates Discord presence (Idle/Thinking/Working/Writing) with 5-second throttling. `begin()`/`end()` count active queries across channels; it returns to Idle when none are running.

7. **Image Input**: `image-processor.ts` downloads Discord attachments, validates via magic bytes, converts to base64 content blocks. Image-only messages (no text) are supported.

8. **File Upload**: `file-upload-manager.ts` (one per reply) uploads files from successful Write tool results and `[UPLOAD: /path]` markers in Claude's text. Paths are realpath-checked against `fileUpload.allowedDirs`, and bot secrets are always blocked.

9. **SDK Options**: `ai-client.ts` builds options once (`buildOptions`). It runs with `settingSources: []` (host `~/.claude` settings are not loaded) and appends `CLAUDE.md` + a pointer to `CLAUDE.local.md` + the playground skill index via `systemPrompt.append`.

### Core Files

| File | Purpose |
|------|---------|
| `src/bot/discord-client.ts` | Discord.js client setup and event handlers |
| `src/bot/message-handler.ts` | Message routing and response orchestration |
| `src/agent/ai-client.ts` | Claude Agent SDK wrapper using V1 `query()` API |
| `src/agent/session-manager.ts` | Session lifecycle, per-channel queue, rewind, compact, clear |
| `src/agent/permission-hook.ts` | Tool approval via Discord UI (PreToolUse hook) |
| `src/persistence/session-store.ts` | Session IDs + rewind points on disk |
| `src/streaming/chunked-updater.ts` | Streaming response handler with message rollover |
| `src/attachments/file-upload-manager.ts` | Claude → Discord file uploads (path-restricted) |
| `src/discord/discord-mcp-server.ts` | Discord read tools exposed to Claude |
| `src/logging/logger.ts` | Configurable logging (use this, not console.log) |

## Configuration

Copy `config.example.json` to `config.json`. Key settings:
- `discordToken`: Bot token (required)
- `allowedUsers`: Discord user IDs allowed to use the bot and approve tools (empty = anyone; logs a warning)
- `allowedChannels`: Channel IDs the bot listens in (empty = all)
- `guildId`: For faster slash command registration; default server for Discord tools
- `dangerousTools`: Tools requiring Discord approval
- `logLevel`: debug/info/warn/error
- `enableChrome`: Enable browser tool for Claude
- `maxQueuedMessages`: Per-channel queue length while Claude is busy
- `fileUpload.allowedDirs`: Directories uploads may come from (default `["./playground"]`)

## Development Guidelines

- Use the logger (`src/logging/logger.ts`) for all output, not console.log (only `index.ts`/`config.ts` bootstrap code runs before a logger exists)
- Update activity status at appropriate lifecycle points
- Sessions must persist across restarts
- New Discord event handlers go through `DiscordBot.guard()` so errors are logged, not fatal
- Anything that touches a channel's session (queries, compaction) runs inside `SessionManager.runExclusive`
- Add or update tests in `test/` for logic changes; run `npm test` and `npm run typecheck`

## Slash Commands

- `/status` - Session info (ID, queue, rewindable exchanges)
- `/clear` - Reset session (stops running reply, deletes SDK transcript, reloads CLAUDE.md + skills)
- `/compact` - Summarize the conversation via the SDK's `/compact`
- `/rewind [count]` - Resume from N exchanges back (conversation only; files are not reverted)
