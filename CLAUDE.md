# Claude Code Project Instructions

## Project Overview
This is a Discord bot that integrates Claude AI via the Claude Agent SDK. The bot allows users to interact with Claude directly through Discord, with features like session management, streaming responses, permission controls, and activity status indicators.

## Development Guidelines

### Working on This Bot
When adding features to **this Discord bot project**, work directly in the main source directories:
- `src/` - Source code for the bot
- `config.json` - Bot configuration
- `package.json` - Dependencies

**Example tasks for the bot:**
- Adding new slash commands
- Implementing image support
- Adding file download features
- Improving logging or status indicators
- Modifying session management

### Working on Unrelated Projects
For **any new development tasks unrelated to this Discord bot**, use the `playground/` directory:

```
playground/
├── project-name-1/     # Each project gets its own folder
│   ├── src/
│   ├── package.json
│   └── README.md
├── project-name-2/
│   ├── ...
└── project-name-3/
    └── ...
```

**Why?**
- Keeps the bot project clean and focused
- Prevents mixing dependencies
- Allows independent development and testing
- Easy to manage multiple experiments

**Example unrelated projects:**
- Web scrapers
- API integrations
- Data analysis scripts
- Test applications
- Prototypes and experiments

### Playground Structure
The `playground/` directory is already set up for this purpose:
- **`claude-monitor/`** - A monitoring tool for Claude Code sessions (cloned repo)
- **Specification documents** - Design specs for upcoming features
  - `IMPLEMENTATION_PLAN.md` - Original comprehensive plan
  - `IMPLEMENTATION_PLAN_FINAL.md` - Refined plan based on requirements
  - `PHASE_2_IMAGE_SUPPORT_SPEC.md` - Detailed spec for image support

**For new projects:**
```bash
# Create a new project in playground
mkdir playground/my-new-project
cd playground/my-new-project
npm init -y
```

## Current Feature Status

### ✅ Phase 1: Complete
- **Discord Presence Status** - Bot shows real-time activity
  - 💤 Idle - Ready for messages
  - 🤔 Thinking... - Processing request
  - ⚙️ Working... - Executing tools
  - ✍️ Writing... - Streaming response

- **Enhanced Terminal Logging** - Configurable, colored logs
  - Log levels: debug, info, warn, error
  - Emoji prefixes for easy scanning
  - Timestamps (ISO format)
  - Streaming progress indicators

- **Configuration System** - Extended config.json
  - Logging settings (level, colors, timestamps)
  - Guild-specific slash commands
  - Attachment settings (ready for Phase 2)
  - File download settings (ready for Phase 3)

### 📋 Phase 2: Planned (Image Support)
See `playground/PHASE_2_IMAGE_SUPPORT_SPEC.md` for detailed specification.
- Download Discord image attachments
- Convert to base64 format
- Pass to Claude Agent SDK via content blocks
- Support multiple images per message
- Size and format validation

### 📋 Phase 3: Planned (File Download)
- Auto-download files created by Write tool
- Manual `/download` command
- Size limits and extension filtering
- Discord attachment integration

## Key Architecture Patterns

### Session Management
- **Per-channel sessions** - Each Discord channel has its own conversation context
- **Persistent storage** - Sessions saved to `data/sessions.json`
- **SDK integration** - Uses Claude Agent SDK's session resumption

### Streaming Responses
- **Chunked updates** - Messages edited every 3 seconds during streaming
- **Rate limit handling** - Exponential backoff on Discord API limits
- **Tool indicators** - Shows when tools are being used

### Permission System
- **Dual approval** - Interactive buttons + emoji reactions (fallback)
- **Dangerous tools** - Configurable list requiring approval
- **Timeout handling** - Auto-deny after configured timeout

### Activity Status
- **Global presence** - Shows bot's current state to all users
- **Force updates** - Important transitions bypass throttling
- **Lifecycle tracking** - Updates throughout request processing

## Important Files

### Configuration
- `config.json` - Main configuration file (not in repo)
- `config.example.json` - Example configuration with all fields
- `src/config.ts` - Configuration type definitions and defaults

### Core Components
- `src/bot/discord-client.ts` - Main Discord.js client and event handlers
- `src/bot/message-handler.ts` - Message processing and routing
- `src/bot/activity-manager.ts` - Discord presence status management
- `src/agent/session-manager.ts` - Session lifecycle management
- `src/agent/ai-client.ts` - Claude Agent SDK integration
- `src/streaming/chunked-updater.ts` - Streaming response handler
- `src/logging/logger.ts` - Configurable logging system

### Slash Commands
- `src/bot/slash-commands.ts` - Command definitions and handlers
- Commands: `/status`, `/clear`, `/compact`

### Permission System
- `src/agent/permission-hook.ts` - Tool permission approval system

## Development Workflow

### Adding Features to the Bot
1. Create new files in appropriate `src/` subdirectories
2. Update `src/config.ts` if new configuration needed
3. Integrate with existing components (logger, activity manager, etc.)
4. Test with the running bot
5. Commit with descriptive messages
6. Update this CLAUDE.md if architecture changes

### Working on Unrelated Projects
1. Create new directory in `playground/`
2. Initialize as independent project
3. Work freely without affecting the bot
4. Document in project's own README

## Testing

### Bot Testing Checklist
- [ ] Log levels work (debug, info, warn, error)
- [ ] Status transitions are correct
- [ ] Slash commands respond properly
- [ ] Sessions persist across restarts
- [ ] Permission system works
- [ ] Error handling doesn't crash bot

### Running the Bot
```bash
npm install
npm run dev  # Development mode with auto-reload
npm start    # Production mode
```

## Dependencies

### Current
- `discord.js` - Discord API client
- `@anthropic-ai/claude-agent-sdk` - Claude integration
- `chalk` - Terminal colors
- `dotenv` - Environment variables (optional)

### For Future Phases
- Phase 2 (Images): No new dependencies (uses built-in fetch, Buffer)
- Phase 3 (Files): Possibly `pdf-parse` for PDF support

## Environment Setup

### Required
- Node.js 18+ (for built-in fetch)
- Discord bot token (in `config.json`)
- Valid `guildId` for faster command registration (optional)

### Configuration
See `config.example.json` for all available options.

## Git Workflow

### Branch Structure
- `main` - Stable releases
- `feature/*` - Feature development (current: `feature/activity-status-images-downloads`)

### Commit Message Format
```
type: Brief description

Detailed explanation if needed.
Bullet points for multiple changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**Types:** feat, fix, docs, refactor, test, chore

## Notes for Claude

### When Working on the Bot
- Use the logger for all output (don't use console.log)
- Update activity status at appropriate points
- Handle errors gracefully (don't crash the bot)
- Respect the throttle system (5s between status updates, except forced)
- Keep sessions persistent across restarts
- Follow the existing architecture patterns

### When Starting New Projects
- Always use `playground/project-name/` structure
- Create independent package.json
- Don't modify the bot's dependencies
- Document the project's purpose in its own README

### File Organization Rules
**Bot files:** `src/`, `config.json`, root-level configs
**Experiments/prototypes:** `playground/project-name/`
**Specifications:** `playground/*.md`
**Temporary work:** `playground/` (with clear project folders)

## Support and Resources

- Discord.js Docs: https://discord.js.org/
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk
- Claude API Docs: https://docs.anthropic.com/

## Metadata

**Project Type:** Discord Bot + Claude AI Integration
**Language:** TypeScript
**Runtime:** Node.js 18+
**Primary Purpose:** Enable Discord users to interact with Claude AI
**Development Mode:** Active - Phase 1 complete, Phase 2 planned
