import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { BotConfig } from "../config.js";
import type { PermissionHook } from "./permission-hook.js";
import type { Logger } from "../logging/logger.js";

export { AbortError };

/** User message content (text and/or image blocks) as accepted by the SDK. */
export type UserMessageParam = SDKUserMessage["message"];

export interface QueryResult {
  success: boolean;
  subtype: string;
  costUsd?: number;
  errors: string[];
}

export interface QueryHandlers {
  onSessionInit?: (sessionId: string) => void;
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown, toolUseId: string) => void;
  onToolResult?: (toolUseId: string, isError: boolean) => void;
  onCompact?: (preTokens: number, postTokens?: number) => void;
  onResult?: (result: QueryResult) => void;
}

export interface QueryRequest {
  // A string is sent as a bare prompt (used for SDK slash commands like /compact,
  // without MCP servers or hooks). A message param is sent via streaming input.
  prompt: string | UserMessageParam;
  resume?: string;
  resumeAt?: string;
  abortController?: AbortController;
}

export interface QueryOutcome {
  // UUID of the last main-chain transcript entry seen (the turn's rewind point)
  lastEntryUuid: string | null;
  aborted: boolean;
}

const DISCORD_MCP_TOOLS = [
  "mcp__discord__discord_fetch_messages",
  "mcp__discord__discord_list_channels",
  "mcp__discord__discord_server_info",
  "mcp__discord__discord_search_messages",
];

// Load CLAUDE.md content to provide context to Claude subprocess
function loadClaudeMdContext(): string | undefined {
  const claudeMdPath = join(process.cwd(), "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      return readFileSync(claudeMdPath, "utf-8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// --- Playground Skill Discovery ---

interface PlaygroundSkill {
  name: string;
  description: string;
  path: string; // relative path to SKILL.md from cwd
}

/** Parse YAML frontmatter from a SKILL.md file. Handles flat key-value pairs only. */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

/** Scan playground/ for SKILL.md files and build a compact skill index. */
function loadPlaygroundSkillIndex(): string | undefined {
  const playgroundDir = join(process.cwd(), "playground");
  if (!existsSync(playgroundDir)) return undefined;

  const SKIP_DIRS = new Set(["archive", "scratchpad"]);
  const SKILL_FILENAMES = ["SKILL.md", "skill.md"];

  const skills: PlaygroundSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(playgroundDir);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const dirPath = join(playgroundDir, entry);

    // Find skill file
    let skillFile: string | null = null;
    for (const filename of SKILL_FILENAMES) {
      const candidate = join(dirPath, filename);
      if (existsSync(candidate)) {
        skillFile = candidate;
        break;
      }
    }
    if (!skillFile) continue;

    let content: string;
    try {
      content = readFileSync(skillFile, "utf-8");
    } catch {
      continue;
    }

    const relativePath = `playground/${entry}/${skillFile.split("/").pop()}`;

    // Try frontmatter first
    const fm = parseFrontmatter(content);
    if (fm?.name && fm?.description) {
      skills.push({ name: fm.name, description: fm.description, path: relativePath });
      continue;
    }

    // Fallback: first # heading as name, directory name as description
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      skills.push({
        name: entry.toLowerCase(),
        description: headingMatch[1].trim(),
        path: relativePath,
      });
    }
  }

  if (skills.length === 0) return undefined;

  const rows = skills
    .map((s) => `| ${s.name} | ${s.path} | ${s.description} |`)
    .join("\n");

  return [
    "## Available Playground Skills",
    "",
    "IMPORTANT: Before performing ANY task related to a skill below, you MUST first",
    "read its SKILL.md for full instructions using the Read tool. Do NOT implement",
    "these capabilities from scratch — tested scripts and workflows already exist.",
    "",
    "| Skill | Path | Description |",
    "|-------|------|-------------|",
    rows,
    "",
    "When a user's request matches a skill description above:",
    "1. Read the skill's SKILL.md file immediately using the Read tool",
    "2. Follow the instructions in that file exactly",
    "3. Use the tested scripts and workflows documented there",
  ].join("\n");
}

// CLAUDE.local.md (gitignored) holds deployment-specific context such as credentials.
// It is deliberately NOT injected into the system prompt, where anyone chatting with the
// bot could ask for it verbatim. Claude is told it exists and reads it on demand.
function loadLocalContextPointer(): string | undefined {
  if (!existsSync(join(process.cwd(), "CLAUDE.local.md"))) return undefined;
  return [
    "## Deployment-Specific Context",
    "",
    "`CLAUDE.local.md` in the working directory holds deployment-specific context",
    "(e.g. GitHub identity and credentials). Read it only when a task needs it.",
    "Never post its contents, or any token, key, or password, into Discord.",
  ].join("\n");
}

function buildSystemPromptAppend(): string | undefined {
  return [loadClaudeMdContext(), loadLocalContextPointer(), loadPlaygroundSkillIndex()]
    .filter(Boolean)
    .join("\n\n") || undefined;
}

let SYSTEM_PROMPT_APPEND = buildSystemPromptAppend();

/** Re-read CLAUDE.md and re-scan playground skills. Called on /clear so changes apply to the next session. */
export function refreshSystemPrompt(): void {
  SYSTEM_PROMPT_APPEND = buildSystemPromptAppend();
}

export class AIClient {
  constructor(
    private config: BotConfig,
    private permissionHook: PermissionHook | null,
    private channelId: string,
    private logger: Logger,
    private discordMcpServer: McpSdkServerConfigWithInstance | null = null
  ) {}

  private buildOptions(request: QueryRequest, withTools: boolean): Options {
    const options: Options = {
      maxTurns: 100,
      model: this.config.model,
      allowedTools: [...this.config.allowedTools],
      cwd: process.cwd(),
      // Isolation mode: don't pick up ~/.claude or .claude/ settings from the host.
      // CLAUDE.md is injected explicitly via systemPrompt.append below.
      settingSources: [],
      extraArgs: this.config.enableChrome ? { chrome: null } : {},
    };

    // Inject CLAUDE.md context + skill index so Claude subprocess has project awareness
    if (SYSTEM_PROMPT_APPEND) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_PROMPT_APPEND,
      };
    }

    if (request.resume) {
      options.resume = request.resume;
      if (request.resumeAt) {
        options.resumeSessionAt = request.resumeAt;
      }
    }

    if (request.abortController) {
      options.abortController = request.abortController;
    }

    if (!withTools) {
      return options;
    }

    // Discord MCP server for channel/message query tools (needs streaming input)
    if (this.discordMcpServer) {
      options.mcpServers = { discord: this.discordMcpServer };
      options.allowedTools!.push(...DISCORD_MCP_TOOLS);
    }

    // Permission hook for dangerous tools
    if (this.permissionHook && this.config.dangerousTools.length > 0) {
      options.hooks = {
        PreToolUse: [
          {
            matcher: `^(${this.config.dangerousTools.join("|")})$`,
            hooks: [this.permissionHook.createHookHandler(this.channelId)],
            // SDK timeout in seconds (must be LONGER than Discord timeout so hook can respond)
            timeout: Math.ceil(this.config.permissionTimeoutMs / 1000) + 5,
          },
        ],
      };
    }

    return options;
  }

  async run(request: QueryRequest, handlers: QueryHandlers = {}): Promise<QueryOutcome> {
    const isCommand = typeof request.prompt === "string";
    const options = this.buildOptions(request, !isCommand);

    const prompt = isCommand
      ? (request.prompt as string)
      : (async function* (message: UserMessageParam): AsyncIterable<SDKUserMessage> {
          yield { type: "user", message, parent_tool_use_id: null };
        })(request.prompt as UserMessageParam);

    const outcome: QueryOutcome = { lastEntryUuid: null, aborted: false };

    try {
      for await (const message of query({ prompt, options })) {
        switch (message.type) {
          case "system":
            if (message.subtype === "init") {
              handlers.onSessionInit?.(message.session_id);
            } else if (message.subtype === "compact_boundary") {
              handlers.onCompact?.(
                message.compact_metadata.pre_tokens,
                message.compact_metadata.post_tokens
              );
            }
            break;

          case "assistant": {
            if (message.parent_tool_use_id === null) {
              outcome.lastEntryUuid = message.uuid;
            }
            for (const block of message.message.content) {
              if (block.type === "text") {
                handlers.onText?.(block.text);
              } else if (block.type === "tool_use") {
                handlers.onToolUse?.(block.name, block.input, block.id);
              }
            }
            break;
          }

          case "user": {
            if (message.parent_tool_use_id === null && message.uuid) {
              outcome.lastEntryUuid = message.uuid;
            }
            const content = message.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  handlers.onToolResult?.(block.tool_use_id, !!block.is_error);
                }
              }
            }
            break;
          }

          case "result":
            handlers.onResult?.({
              success: message.subtype === "success" && !message.is_error,
              subtype: message.subtype,
              costUsd: message.total_cost_usd,
              errors: "errors" in message ? message.errors : [],
            });
            break;
        }
      }
    } catch (error) {
      if (error instanceof AbortError || request.abortController?.signal.aborted) {
        outcome.aborted = true;
        return outcome; // Expected cancellation (e.g. /clear or /rewind mid-query)
      }
      this.logger.error("🤖 AI", "Query error", (error as Error).message);
      throw error;
    }

    return outcome;
  }
}
