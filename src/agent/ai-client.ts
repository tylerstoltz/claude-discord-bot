import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BotConfig } from "../config.js";
import type { PermissionHook } from "./permission-hook.js";
import type { ChunkedUpdater } from "../streaming/chunked-updater.js";

export interface QueryCallbacks {
  onSessionInit?: (sessionId: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  onText?: (text: string) => void;
  onResult?: (success: boolean, cost?: number) => void;
}

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
      executable: "/usr/bin/node",
    };

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
}
