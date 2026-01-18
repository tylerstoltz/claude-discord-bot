import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BotConfig } from "../config.js";
import type { PermissionHook } from "./permission-hook.js";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";

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

const CLAUDE_MD_CONTEXT = loadClaudeMdContext();

export class AIClient {
  constructor(
    private config: BotConfig,
    private permissionHook: PermissionHook | null,
    private channelId: string
  ) {}

  async *queryStream(
    prompt: string,
    resumeSessionId?: string
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

    // Inject CLAUDE.md context so Claude subprocess has project awareness
    if (CLAUDE_MD_CONTEXT) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: CLAUDE_MD_CONTEXT
      };
    }

    // Resume session if we have a session ID
    if (resumeSessionId) {
      options.resume = resumeSessionId;
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
            // SDK timeout in seconds (must be longer than our Discord timeout)
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
      console.error("[AI] Query error:", error);
      throw error;
    }
  }

  async queryWithUpdater(
    prompt: string,
    updater: ChunkedUpdater,
    resumeSessionId?: string,
    callbacks?: QueryCallbacks
  ): Promise<string | null> {
    let newSessionId: string | null = null;

    for await (const event of this.queryStream(prompt, resumeSessionId)) {
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
    callbacks?: QueryCallbacks
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

    // Inject CLAUDE.md context so Claude subprocess has project awareness
    if (CLAUDE_MD_CONTEXT) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: CLAUDE_MD_CONTEXT
      };
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Add permission hooks if configured
    if (this.permissionHook && this.config.dangerousTools.length > 0) {
      const matcher = this.config.dangerousTools.join("|");
      options.hooks = {
        PreToolUse: [
          {
            matcher,
            hooks: [this.permissionHook.createHookHandler(this.channelId)],
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
      console.error("[AI] Query error:", error);
      throw error;
    }
  }
}
