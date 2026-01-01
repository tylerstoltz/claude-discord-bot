# Scope of Work: Fix `/clear` Command to Delete SDK Sessions

## Problem Statement

The current `/clear` command implementation only clears the session mapping in `data/sessions.json` but does NOT delete the underlying SDK session files stored in `~/.claude/projects/{project-path}/{sessionId}.jsonl`. This results in:

1. **Session accumulation**: 16+ empty session files + 1 large 2.5 MB active session
2. **No true reset**: Conversation context persists in SDK even after "clearing"
3. **Memory bloat**: Session files grow indefinitely without proper cleanup
4. **User confusion**: `/clear` appears to work but doesn't actually free resources

## Current Behavior

**File**: `src/agent/session-manager.ts` - `clearSession()` method

```typescript
async clearSession(channelId: string): Promise<void> {
  const session = this.activeSessions.get(channelId);

  if (session) {
    session.sdkSessionId = null;  // Only clears reference
    session.isProcessing = false;
    session.lastActivity = new Date();
  }

  this.sessionStore.clearSession(channelId);  // Only clears mapping
  await this.sessionStore.save();

  this.logger.info('💾 SESSION', `Cleared session for channel ${channelId.slice(-6)}`);
}
```

**What happens**:
- ✅ In-memory session reference cleared
- ✅ Mapping in `data/sessions.json` removed
- ❌ SDK session file (`~/.claude/projects/.../uuid.jsonl`) remains on disk
- ❌ No actual context reset

## Desired Behavior

When `/clear` is executed:

1. ✅ Clear in-memory session reference (existing)
2. ✅ Clear session mapping in `data/sessions.json` (existing)
3. **NEW**: Delete SDK session file from `~/.claude/projects/{project-path}/{sessionId}.jsonl`
4. **NEW**: Log confirmation of file deletion
5. **NEW**: Handle errors gracefully (file not found, permission issues)

## Implementation Plan

### 1. Add Session File Deletion Logic

**Location**: `src/agent/session-manager.ts`

**Changes**:
```typescript
import { unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

async clearSession(channelId: string): Promise<void> {
  const session = this.activeSessions.get(channelId);
  const sessionId = session?.sdkSessionId;

  // NEW: Delete SDK session file before clearing references
  if (sessionId) {
    await this.deleteSdkSessionFile(sessionId);
  }

  // Existing clearing logic...
  if (session) {
    session.sdkSessionId = null;
    session.isProcessing = false;
    session.lastActivity = new Date();
  }

  this.sessionStore.clearSession(channelId);
  await this.sessionStore.save();

  this.logger.info('💾 SESSION', `Cleared session for channel ${channelId.slice(-6)}`);
}

private async deleteSdkSessionFile(sessionId: string): Promise<void> {
  try {
    // Construct SDK session file path
    const projectPath = process.cwd().replace(/\//g, '-').substring(1);
    const sessionFilePath = join(
      homedir(),
      '.claude',
      'projects',
      projectPath,
      `${sessionId}.jsonl`
    );

    // Delete the file
    await unlink(sessionFilePath);
    this.logger.info('🗑️  DELETE', `Deleted SDK session file`, sessionId.slice(0, 8));
  } catch (error) {
    // Don't throw - file might not exist or already deleted
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      this.logger.warn('🗑️  DELETE', `Failed to delete session file`, (error as Error).message);
    }
  }
}
```

### 2. Testing Strategy

**Manual Testing**:
1. Start bot and send messages to create session
2. Verify session file exists: `ls ~/.claude/projects/{project-path}/`
3. Execute `/clear` command
4. Verify session file deleted: `ls ~/.claude/projects/{project-path}/`
5. Send new message and verify fresh session created

**Edge Cases**:
- ✅ Session file doesn't exist (ENOENT error)
- ✅ Permission denied (log warning, continue)
- ✅ Invalid session ID
- ✅ Session already cleared

### 3. User Feedback

**Before fix**:
```
User: /clear
Bot: ✅ Session cleared for channel abc123
# (But session file still exists on disk)
```

**After fix**:
```
User: /clear
Bot: ✅ Session cleared for channel abc123
# Log shows:
# 💾 SESSION | Cleared session for channel abc123
# 🗑️  DELETE | Deleted SDK session file | 35e8722d
```

## Success Criteria

1. ✅ SDK session files are deleted when `/clear` is executed
2. ✅ No orphaned session files accumulate over time
3. ✅ Next user message starts with truly fresh context
4. ✅ Error handling prevents crashes from missing/locked files
5. ✅ Logging confirms deletion occurred

## Files Modified

1. **src/agent/session-manager.ts**
   - Add `deleteSdkSessionFile()` private method
   - Call deletion in `clearSession()` before clearing references
   - Add imports: `unlink`, `join`, `homedir`

## Rollback Plan

If issues arise:
1. Revert changes to `session-manager.ts`
2. Original behavior preserved (just clear references)
3. No data loss - session files remain on disk

## Future Enhancements (Not in Scope)

- Auto-cleanup of old session files (>7 days)
- Session size warnings (>1 MB)
- `/rewind` command to rollback N turns
- Compaction with summarization
- Session export/import

## Timeline

- **Implementation**: 10 minutes
- **Testing**: 5 minutes
- **Documentation**: Already complete (this doc)
- **Total**: 15 minutes

## Dependencies

- Node.js `fs/promises` module (built-in)
- Existing logger system
- No new npm packages required

## Risks

**Low Risk**:
- File deletion is straightforward
- Error handling prevents crashes
- User data (conversation mapping) already cleared

**Mitigation**:
- Graceful error handling for missing files
- Logging for debugging
- No breaking changes to API
