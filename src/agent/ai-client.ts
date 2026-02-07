import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { BotConfig } from "../config.js";
import type { PermissionHook } from "./permission-hook.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";

export { AbortError };

export interface QueryCallbacks {
  onSessionInit?: (sessionId: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  onText?: (text: string) => void;
  onResult?: (success: boolean, cost?: number) => void;
}

// Load CLAUDE.md content at startup to provide context to Claude subprocess
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

// Load CLAUDE.local.md for deployment-specific context (gitignored)
function loadLocalContext(): string | undefined {
  const localMdPath = join(process.cwd(), "CLAUDE.local.md");
  if (existsSync(localMdPath)) {
    try {
      return readFileSync(localMdPath, "utf-8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const CLAUDE_MD_CONTEXT = loadClaudeMdContext();
const LOCAL_CONTEXT = loadLocalContext();
let SKILL_INDEX = loadPlaygroundSkillIndex();
let SYSTEM_PROMPT_APPEND = [CLAUDE_MD_CONTEXT, LOCAL_CONTEXT, SKILL_INDEX]
  .filter(Boolean)
  .join("\n\n") || undefined;

/** Re-scan playground skills and local context. Call on /clear so new skills appear in next session. */
export function refreshSystemPrompt(): void {
  const localCtx = loadLocalContext();
  SKILL_INDEX = loadPlaygroundSkillIndex();
  SYSTEM_PROMPT_APPEND = [CLAUDE_MD_CONTEXT, localCtx, SKILL_INDEX]
    .filter(Boolean)
    .join("\n\n") || undefined;
}

export class AIClient {
  constructor(
    private config: BotConfig,
    private permissionHook: PermissionHook | null,
    private channelId: string,
    private discordMcpServer: McpSdkServerConfigWithInstance | null = null
  ) {}

  async *queryStream(
    prompt: string,
    resumeSessionId?: string,
    abortController?: AbortController
  ): AsyncIterable<{
    type: string;
    sessionId?: string;
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    success?: boolean;
    cost?: number;
  }> {
    const options: any = {
      maxTurns: 100,
      model: this.config.model,
      allowedTools: this.config.allowedTools,
      cwd: process.cwd(),
      extraArgs: this.config.enableChrome ? { chrome: null } : {},
    };

    // Inject CLAUDE.md context + skill index so Claude subprocess has project awareness
    if (SYSTEM_PROMPT_APPEND) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT_APPEND
      };
    }

    // Resume session if we have a session ID
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Pass abort controller for cancellation support
    if (abortController) {
      options.abortController = abortController;
    }

    // Add Discord MCP server for channel/message query tools
    if (this.discordMcpServer) {
      options.mcpServers = { discord: this.discordMcpServer };
      options.allowedTools = [
        ...(options.allowedTools || []),
        "mcp__discord__discord_fetch_messages",
        "mcp__discord__discord_list_channels",
        "mcp__discord__discord_server_info",
        "mcp__discord__discord_search_messages",
      ];
    }

    // Add permission hooks if configured
    if (this.permissionHook && this.config.dangerousTools.length > 0) {
      const matcher = this.config.dangerousTools.join("|");
      options.hooks = {
        PreToolUse: [
          {
            matcher,
            hooks: [
              this.permissionHook.createHookHandler(this.channelId),
            ],
            // SDK timeout in seconds (must be LONGER than Discord timeout so hook can respond)
            timeout: Math.ceil(this.config.permissionTimeoutMs / 1000) + 5,
          },
        ],
      };
    }

    try {
      const q = query({ prompt, options });

      for await (const message of q) {
        // Handle different message types
        if (message.type === "system" && (message as any).subtype === "init") {
          yield {
            type: "session_init",
            sessionId: (message as any).session_id,
          };
        } else if (message.type === "assistant") {
          const content = (message as any).message?.content;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                yield { type: "text", text: block.text };
              } else if (block.type === "tool_use") {
                yield {
                  type: "tool_use",
                  toolName: block.name,
                  toolInput: block.input,
                };
              }
            }
          } else if (typeof content === "string") {
            yield { type: "text", text: content };
          }
        } else if (message.type === "result") {
          yield {
            type: "result",
            success: (message as any).subtype === "success",
            cost: (message as any).total_cost_usd,
          };
        }
      }
    } catch (error) {
      if (error instanceof AbortError) {
        return; // Expected cancellation, exit silently
      }
      console.error("[AI] Query error:", error);
      throw error;
    }
  }

  async queryWithUpdater(
    prompt: string,
    updater: ChunkedUpdater,
    resumeSessionId?: string,
    callbacks?: QueryCallbacks,
    abortController?: AbortController
  ): Promise<string | null> {
    let newSessionId: string | null = null;

    for await (const event of this.queryStream(prompt, resumeSessionId, abortController)) {
      switch (event.type) {
        case "session_init":
          newSessionId = event.sessionId || null;
          callbacks?.onSessionInit?.(event.sessionId!);
          break;

        case "text":
          if (event.text) {
            updater.appendContent(event.text);
            callbacks?.onText?.(event.text);
          }
          break;

        case "tool_use":
          updater.onToolUse(event.toolName!, event.toolInput);
          callbacks?.onToolUse?.(event.toolName!, event.toolInput);
          break;

        case "result":
          callbacks?.onResult?.(event.success!, event.cost);
          break;
      }
    }

    return newSessionId;
  }

  async queryWithMessage(
    userMessage: any, // MessageParam from Anthropic SDK
    updater: ChunkedUpdater,
    resumeSessionId?: string,
    callbacks?: QueryCallbacks,
    abortController?: AbortController
  ): Promise<void> {
    // Create async iterable that yields the SDK user message
    const messageStream = async function* () {
      yield {
        type: 'user' as const,
        message: userMessage,
        parent_tool_use_id: null,
        session_id: resumeSessionId || ''
      };
    };

    const options: any = {
      maxTurns: 100,
      model: this.config.model,
      allowedTools: this.config.allowedTools,
      cwd: process.cwd(),
      extraArgs: this.config.enableChrome ? { chrome: null } : {},
    };

    // Inject CLAUDE.md context + skill index so Claude subprocess has project awareness
    if (SYSTEM_PROMPT_APPEND) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT_APPEND
      };
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Pass abort controller for cancellation support
    if (abortController) {
      options.abortController = abortController;
    }

    // Add Discord MCP server for channel/message query tools
    if (this.discordMcpServer) {
      options.mcpServers = { discord: this.discordMcpServer };
      options.allowedTools = [
        ...(options.allowedTools || []),
        "mcp__discord__discord_fetch_messages",
        "mcp__discord__discord_list_channels",
        "mcp__discord__discord_server_info",
        "mcp__discord__discord_search_messages",
      ];
    }

    // Add permission hooks if configured
    if (this.permissionHook && this.config.dangerousTools.length > 0) {
      const matcher = this.config.dangerousTools.join("|");
      options.hooks = {
        PreToolUse: [
          {
            matcher,
            hooks: [this.permissionHook.createHookHandler(this.channelId)],
            // SDK timeout in seconds (must be LONGER than Discord timeout so hook can respond)
            timeout: Math.ceil(this.config.permissionTimeoutMs / 1000) + 5,
          },
        ],
      };
    }

    try {
      const q = query({
        prompt: messageStream(),
        options
      });

      // Stream events
      for await (const message of q) {
        if (message.type === "system" && (message as any).subtype === "init") {
          callbacks?.onSessionInit?.((message as any).session_id);
        } else if (message.type === "assistant") {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                updater.appendContent(block.text);
                callbacks?.onText?.(block.text);
              } else if (block.type === "tool_use") {
                updater.onToolUse(block.name, block.input);
                callbacks?.onToolUse?.(block.name, block.input);
              }
            }
          } else if (typeof content === "string") {
            updater.appendContent(content);
            callbacks?.onText?.(content);
          }
        } else if (message.type === "result") {
          callbacks?.onResult?.(
            (message as any).subtype === "success",
            (message as any).total_cost_usd
          );
        }
      }
    } catch (error) {
      if (error instanceof AbortError) {
        return; // Expected cancellation, exit silently
      }
      console.error("[AI] Query error:", error);
      throw error;
    }
  }
}
