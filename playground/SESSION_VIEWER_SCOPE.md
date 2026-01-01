# Scope of Work: Claude Session Viewer

## Project Overview

A standalone web application to visualize, browse, and analyze Claude Agent SDK session data stored in `~/.claude/projects/`. This tool allows developers to review conversation history, inspect tool calls, copy prompts, examine timestamps, and understand session evolution over time.

**Project Type**: Standalone web application (separate from Discord bot)
**Location**: `playground/session-viewer/`
**Tech Stack**: Static HTML generator + optional live server for real-time updates

## Problem Statement

Currently, Claude SDK sessions are stored as JSONL files in `~/.claude/projects/{project-path}/{sessionId}.jsonl` with no built-in visualization tools. Developers need to:

- Review past conversations to understand context growth
- Debug issues by examining tool calls and responses
- Copy prompts and messages for documentation
- Analyze session size and token usage
- Identify which sessions can be safely deleted
- Understand conversation flow and branching

**Current workflow** (manual and tedious):
```bash
cd ~/.claude/projects/
ls -lh  # See file sizes
cat {uuid}.jsonl | jq  # Parse JSON manually
grep "tool_use" *.jsonl  # Search for specific events
```

## Proposed Solution

### Option A: Static HTML Generator (Recommended)

**Why**: Simple, portable, no server required, works offline, easy to share

A Node.js script that:
1. Scans `~/.claude/projects/` for all session JSONL files
2. Parses each session and extracts metadata
3. Generates a single-page HTML file with embedded CSS/JS
4. Includes search, filtering, and timeline visualization
5. Can be regenerated on-demand or via watch mode

**Output**: `session-viewer.html` (self-contained, double-click to open)

### Option B: Live Web Server

**Why**: Real-time updates, better for active development, richer interactivity

An Express.js server that:
1. Serves a React/Vue frontend
2. Provides REST API to query sessions
3. Auto-refreshes when new sessions detected
4. Supports session comparison and diff views

**Output**: `http://localhost:3000` (requires `npm start`)

**Recommendation**: Start with **Option A** (static generator) for simplicity, then add Option B features if needed.

## Features & Requirements

### Core Features (MVP)

#### 1. Session Index View
- **List all sessions** across all projects
- Display per session:
  - Project name (from directory path)
  - Session ID (truncated with copy button)
  - File size (MB)
  - Message count
  - First message timestamp
  - Last message timestamp
  - Duration (time between first/last message)
  - Status (active/idle/errored)
- **Sort by**: date, size, message count, project
- **Filter by**: project, date range, size threshold
- **Search**: full-text search across all messages

#### 2. Session Detail View
- **Conversation timeline**: Chronological view of all messages
- **Message types**:
  - 👤 **User messages**: Show text content, images (base64 preview), attachments
  - 🤖 **Assistant messages**: Show text responses, thinking process
  - 🔧 **Tool use**: Show tool name, input parameters (syntax highlighted JSON)
  - ✅ **Tool results**: Show outputs, success/error status
  - ⏸️ **Session events**: Resume points, compaction markers

- **Per-message metadata**:
  - Timestamp (absolute + relative)
  - Token count (if available)
  - Parent tool use ID (for tracking context)
  - Event type and role

- **Visual elements**:
  - Syntax highlighting for JSON/code blocks
  - Image thumbnails for base64 images
  - Collapsible sections for long outputs
  - Copy button for each message/tool call

#### 3. Session Analytics
- **Token usage graph**: Visual representation of session growth
- **Tool usage summary**: Which tools used, how many times
- **Message frequency timeline**: Activity over time
- **Size breakdown**: User vs assistant vs tool content

#### 4. Export & Utilities
- **Export session** as:
  - Plain text (conversation only)
  - Markdown (formatted with metadata)
  - JSON (raw JSONL)
  - HTML (standalone file for single session)
- **Copy to clipboard**: Individual messages, tool calls, or entire sessions
- **Delete session**: With confirmation prompt
- **Session stats**: Total sessions, total size, oldest/newest

### Advanced Features (Future)

- **Session comparison**: Side-by-side diff of two sessions
- **Conversation branching**: Visualize where sessions diverged (if SDK supports)
- **Search & replace**: Find patterns across all sessions
- **Session replay**: Step through conversation turn-by-turn
- **Performance metrics**: Response times, tool execution duration
- **AI summary**: Auto-generate summary of what session accomplished
- **Session tagging**: Add custom labels/notes to sessions

## Technical Architecture

### Data Flow

```
~/.claude/projects/
└── {project-path}/
    ├── {uuid-1}.jsonl  ──┐
    ├── {uuid-2}.jsonl  ──┤
    └── {uuid-3}.jsonl  ──┤
                          │
                          ├─> Scanner reads all JSONL files
                          │
                          ├─> Parser extracts sessions, messages, metadata
                          │
                          ├─> Generator builds HTML with embedded data
                          │
                          └─> Output: session-viewer.html
                              (self-contained, portable)
```

### File Structure

```
playground/session-viewer/
├── README.md                      # Project documentation
├── package.json                   # Dependencies
├── src/
│   ├── scanner.ts                 # Scan ~/.claude/projects/
│   ├── parser.ts                  # Parse JSONL files
│   ├── generator.ts               # Generate HTML
│   ├── types.ts                   # TypeScript types
│   └── cli.ts                     # CLI entry point
├── templates/
│   ├── index.html                 # HTML template
│   ├── styles.css                 # Embedded CSS
│   └── script.js                  # Embedded JS (search, filter, UI)
└── dist/
    └── session-viewer.html        # Generated output
```

### Data Model

#### SessionIndex
```typescript
interface SessionIndex {
  projects: ProjectSummary[];
  totalSessions: number;
  totalSizeMB: number;
  generatedAt: string;
}

interface ProjectSummary {
  projectPath: string;
  projectName: string;
  sessions: SessionSummary[];
}

interface SessionSummary {
  sessionId: string;
  filePath: string;
  fileSize: number;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  durationMs: number;
  toolCalls: number;
  status: 'active' | 'idle' | 'errored';
}
```

#### SessionDetail
```typescript
interface SessionDetail {
  sessionId: string;
  messages: SessionMessage[];
  metadata: SessionMetadata;
}

interface SessionMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'session_event';
  timestamp: string;
  role?: string;
  content?: MessageContent[];
  toolName?: string;
  toolInput?: Record<string, any>;
  toolOutput?: string;
  parentToolUseId?: string | null;
}

interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface SessionMetadata {
  totalTokens?: number;
  toolUsage: Record<string, number>;
  messageTypes: Record<string, number>;
  sizeBreakdown: {
    user: number;
    assistant: number;
    tools: number;
  };
}
```

### JSONL Format Reference

Based on SDK session files, each line is a JSON object representing an event:

```jsonl
{"type":"user","timestamp":"2024-01-15T10:30:00.000Z","role":"user","content":[{"type":"text","text":"Hello"}]}
{"type":"assistant","timestamp":"2024-01-15T10:30:01.000Z","role":"assistant","content":[{"type":"text","text":"Hi there!"}]}
{"type":"tool_use","timestamp":"2024-01-15T10:30:05.000Z","toolName":"Read","input":{"file_path":"/foo/bar.ts"}}
{"type":"tool_result","timestamp":"2024-01-15T10:30:06.000Z","output":"file contents...","parent_tool_use_id":"toolu_123"}
```

**Note**: Actual format may vary - need to inspect real session files to confirm exact schema.

## UI/UX Design

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Session Viewer                    🔍 [Search]  ⚙️   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Sidebar (25%)              │  Main Content (75%)            │
│  ─────────────             │  ─────────────────             │
│                             │                                │
│  📊 Overview                │  Session Detail View           │
│  • 23 sessions              │  ┌──────────────────────┐    │
│  • 12.5 MB total            │  │ Session: 35e8722d... │    │
│  • 3 projects               │  │ 2.5 MB • 45 messages │    │
│                             │  └──────────────────────┘    │
│  📁 Projects                │                                │
│  └─ claude-discord-bot (12) │  ┌─ 👤 User ─────────────┐   │
│  └─ my-agent (8)            │  │ 10:30 AM               │   │
│  └─ test-project (3)        │  │ Hello, can you help?   │   │
│                             │  └────────────────────────┘   │
│  🔍 Filters                 │                                │
│  □ Show empty sessions      │  ┌─ 🤖 Assistant ────────┐   │
│  □ > 1 MB only              │  │ 10:30 AM               │   │
│  ☑ Active sessions          │  │ Of course! What do you │   │
│                             │  │ need help with?        │   │
│  📅 Date Range              │  └────────────────────────┘   │
│  [Last 7 days ▼]            │                                │
│                             │  ┌─ 🔧 Tool: Read ───────┐   │
│                             │  │ 10:30 AM               │   │
│                             │  │ {                      │   │
│                             │  │   "file_path": "..."   │   │
│                             │  │ }                      │   │
│                             │  │ [Copy] [Expand]        │   │
│                             │  └────────────────────────┘   │
│                             │                                │
└─────────────────────────────────────────────────────────────┘
```

### Color Scheme

- **User messages**: Blue accent (`#3B82F6`)
- **Assistant messages**: Green accent (`#10B981`)
- **Tool use**: Orange accent (`#F59E0B`)
- **Tool results**: Gray accent (`#6B7280`)
- **Errors**: Red accent (`#EF4444`)
- **Background**: Dark mode by default (`#1F2937` / `#111827`)

### Interactions

- **Click session** in sidebar → Load detail view
- **Click message** → Expand/collapse content
- **Click copy button** → Copy to clipboard (with toast notification)
- **Search bar** → Highlight matches in real-time
- **Filter checkboxes** → Update visible sessions
- **Scroll timeline** → Lazy load messages for performance

## Implementation Plan

### Phase 1: Core Scanner & Parser (Day 1)

**Goal**: Read and parse session JSONL files

1. **Setup project**:
   ```bash
   cd playground/
   mkdir session-viewer
   cd session-viewer
   npm init -y
   npm install --save-dev typescript @types/node
   npm install commander chalk filesize
   ```

2. **Create scanner.ts**:
   - Recursively scan `~/.claude/projects/`
   - Find all `.jsonl` files
   - Extract file metadata (size, modified time)

3. **Create parser.ts**:
   - Read JSONL files line-by-line
   - Parse each JSON event
   - Build SessionDetail object
   - Calculate metadata (message count, tool usage, etc.)

4. **Create types.ts**:
   - Define all TypeScript interfaces
   - Based on actual JSONL format inspection

5. **Test with real data**:
   - Point at `~/.claude/projects/`
   - Verify parsing of current session files
   - Handle edge cases (empty files, malformed JSON)

### Phase 2: HTML Generator (Day 2)

**Goal**: Generate static HTML viewer

1. **Create templates/**:
   - `index.html`: Basic structure with placeholders
   - `styles.css`: Tailwind-inspired utility classes
   - `script.js`: Search, filter, navigation logic

2. **Create generator.ts**:
   - Load session data from parser
   - Inject into HTML template
   - Embed CSS and JS inline
   - Write to `dist/session-viewer.html`

3. **Implement client-side features**:
   - Search across all messages
   - Filter by project/date/size
   - Expand/collapse messages
   - Copy to clipboard
   - Syntax highlighting (Prism.js or similar)

4. **Test generated HTML**:
   - Open in browser (no server needed)
   - Verify all features work
   - Test with large sessions (>1000 messages)

### Phase 3: CLI & Polish (Day 3)

**Goal**: User-friendly CLI tool

1. **Create cli.ts**:
   ```bash
   session-viewer generate              # Generate HTML
   session-viewer watch                 # Regenerate on changes
   session-viewer stats                 # Print summary
   session-viewer clean                 # Delete old sessions
   session-viewer export <id> --format md
   ```

2. **Add features**:
   - Progress bars for scanning
   - Colored output with chalk
   - File size formatting (12.5 MB not 13107200 bytes)
   - Error handling with helpful messages

3. **Documentation**:
   - Update README.md with usage examples
   - Add screenshots (mock or real)
   - Installation instructions

4. **Testing**:
   - Test with multiple projects
   - Test with empty `.claude/` directory
   - Test with corrupted JSONL files
   - Performance test with 100+ sessions

### Phase 4: Advanced Features (Optional)

- **Session comparison**: Diff two sessions
- **Export formats**: Markdown, plain text, JSON
- **Delete sessions**: With confirmation
- **Analytics dashboard**: Charts and graphs
- **Live mode**: Auto-refresh when files change

## CLI Usage Examples

```bash
# Generate viewer from all sessions
$ cd playground/session-viewer
$ npm run build
$ npm run generate
✨ Scanning ~/.claude/projects/...
📂 Found 3 projects
📄 Found 23 session files (12.5 MB total)
🔍 Parsing sessions...
[████████████████████████████████████] 100% | 23/23 sessions
✅ Generated dist/session-viewer.html (850 KB)
🌐 Open dist/session-viewer.html in your browser

# Watch mode (regenerate on changes)
$ npm run watch
👀 Watching ~/.claude/projects/ for changes...
✅ Generated dist/session-viewer.html
   [Updated 2s ago]

# Show stats without generating
$ npm run stats
📊 Session Statistics
  • Total sessions: 23
  • Total size: 12.5 MB
  • Largest session: 35e8722d... (2.5 MB, 127 messages)
  • Oldest session: 2024-01-10 14:23:00
  • Newest session: 2024-01-15 16:45:30

  📁 By Project:
    • claude-discord-bot: 12 sessions (8.2 MB)
    • my-agent: 8 sessions (3.1 MB)
    • test-project: 3 sessions (1.2 MB)

# Export specific session
$ npm run export 35e8722d -- --format markdown
📝 Exporting session 35e8722d...
✅ Exported to exports/35e8722d.md (45 KB)

# Clean old/empty sessions
$ npm run clean -- --older-than 30d --empty
🗑️  Found 5 sessions to delete:
  • 3 empty sessions (0 messages)
  • 2 sessions older than 30 days

  Delete these sessions? (y/N): y
✅ Deleted 5 sessions (freed 234 KB)
```

## Dependencies

### Core
- **TypeScript**: Type safety
- **Node.js 18+**: fs/promises, path, os modules

### CLI
- **commander**: CLI argument parsing
- **chalk**: Colored terminal output
- **ora**: Spinner animations
- **filesize**: Human-readable file sizes

### HTML Generation
- **No build step needed**: Vanilla JS, embedded in HTML
- **Optional**: Prism.js (syntax highlighting, CDN link)
- **Optional**: Chart.js (analytics graphs, CDN link)

### Development
- **tsx**: Run TypeScript directly
- **nodemon**: Watch mode for development

## File Size & Performance

### Estimations

- **Source code**: ~15 KB (scanner, parser, generator)
- **Templates**: ~30 KB (HTML + CSS + JS)
- **Generated HTML**: ~500 KB - 2 MB (depends on session count)
  - Session index data: ~10 KB per session
  - Embedded sessions: Full message content
  - Syntax highlighting library: ~50 KB (CDN)

### Performance Optimizations

1. **Lazy loading**: Only load session details when clicked
2. **Virtual scrolling**: For sessions with 1000+ messages
3. **Compression**: Optionally gzip generated HTML
4. **Indexing**: Pre-compute search indices
5. **Caching**: Cache parsed sessions during watch mode

### Scalability

- **100 sessions**: ~2 MB HTML, <1s generation time
- **1000 sessions**: ~20 MB HTML, ~5s generation time
- **10000 sessions**: Consider database (SQLite) instead of static HTML

## Success Criteria

### MVP Complete When:
1. ✅ Can scan `~/.claude/projects/` and find all sessions
2. ✅ Can parse JSONL files and extract messages/metadata
3. ✅ Generates self-contained HTML file
4. ✅ Can browse sessions in sidebar
5. ✅ Can view message timeline for each session
6. ✅ Can search across all messages
7. ✅ Can copy messages to clipboard
8. ✅ Shows tool calls with syntax-highlighted JSON
9. ✅ Displays image thumbnails for base64 images
10. ✅ Works offline (no server required)

### Quality Metrics:
- **Generation time**: <5s for 100 sessions
- **HTML size**: <5 MB for 100 sessions
- **Browser performance**: Smooth scrolling with 1000+ messages
- **Search speed**: <100ms for full-text search
- **Error handling**: Graceful degradation for corrupted files

## Future Enhancements

### Integration Ideas
- **Discord bot integration**: `/sessions` command to open viewer
- **VS Code extension**: View sessions in editor sidebar
- **GitHub Action**: Auto-generate viewer on CI/CD
- **Electron app**: Desktop application with native file access

### Advanced Analytics
- **Token usage tracking**: Parse SDK responses for token counts
- **Cost estimation**: Calculate API costs per session
- **Performance profiling**: Tool execution times, response latencies
- **Conversation quality**: Detect loops, repetition, errors

### Collaboration Features
- **Session sharing**: Export as shareable link (with privacy controls)
- **Annotations**: Add comments/notes to specific messages
- **Bookmarks**: Mark important conversations
- **Tags**: Organize sessions with custom labels

## Timeline

- **Day 1** (4 hours): Scanner + Parser implementation
- **Day 2** (4 hours): HTML Generator + Templates
- **Day 3** (3 hours): CLI + Documentation + Testing
- **Total**: 11 hours for MVP

**Optional extensions**: +2-4 hours per advanced feature

## Risks & Mitigations

### Risk: JSONL format changes
**Mitigation**: Add format version detection, backwards compatibility

### Risk: Very large session files (>100 MB)
**Mitigation**: Stream parsing, pagination, size warnings

### Risk: Performance issues with many sessions
**Mitigation**: Lazy loading, virtual scrolling, database option

### Risk: Security (exposing session data)
**Mitigation**: Local-only tool, no network requests, sanitize output

### Risk: Corrupted/malformed JSONL
**Mitigation**: Error handling, skip invalid lines, show warnings

## Getting Started

```bash
# Create project
cd playground/
mkdir session-viewer
cd session-viewer

# Initialize
npm init -y
npm install --save-dev typescript @types/node tsx nodemon
npm install commander chalk ora filesize

# Create structure
mkdir -p src templates dist

# Start development
npm run dev  # Watch mode with tsx

# Generate viewer
npm run generate
open dist/session-viewer.html
```

## Conclusion

This tool will provide essential visibility into Claude SDK session data, making it easier to:
- Debug conversation context issues
- Document successful prompts and patterns
- Manage session storage and cleanup
- Analyze tool usage and performance
- Share conversations for collaboration

The static HTML approach ensures maximum portability and simplicity, while still providing rich interactivity through client-side JavaScript. Future enhancements can add server-based features if needed.

**Next Steps**: Approve scope, then implement Phase 1 (Scanner + Parser) in a new work session.
