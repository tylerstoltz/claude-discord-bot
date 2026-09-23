import {
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  MessageFlags,
} from "discord.js";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { isUserAllowed, type BotConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";

interface PendingApproval {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  discordMessageId: string;
  channelId: string;
  // cancelledText: settle as denied and show this footer instead of "Denied"
  resolve: (approved: boolean, byUserId?: string, cancelledText?: string) => void;
  timeout: NodeJS.Timeout;
}

export class PermissionHook {
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    private config: BotConfig,
    private getChannel: (channelId: string) => TextChannel | null,
    private logger: Logger
  ) {}

  createHookHandler(channelId: string): HookCallback {
    return async (input, toolUseId, { signal }): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') {
        return {};
      }
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // Check if this is a dangerous tool
      if (!this.config.dangerousTools.includes(toolName)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Denials don't set `continue: false`: that would stop Claude's whole turn,
      // whereas a plain deny lets it read the reason and try something else.
      const channel = this.getChannel(channelId);
      if (!channel) {
        this.logger.error('🔒 PERMISSION', `Channel ${channelId.slice(-6)} not found`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Cannot request permission: channel not found'
          }
        };
      }

      const id = toolUseId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      this.logger.info('🔒 PERMISSION', `Requesting approval for ${toolName}`, `ID: ${id.slice(0, 8)}`);

      const approved = await this.requestApproval(channel, toolName, toolInput, id, signal);

      if (approved) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      } else {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'The user denied permission for this operation (or the request timed out). Do not retry it; ask the user how to proceed.'
          }
        };
      }
    };
  }

  private async requestApproval(
    channel: TextChannel,
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    // Format tool input for display
    let inputDisplay: string;
    try {
      const inputStr = JSON.stringify(toolInput, null, 2);
      inputDisplay = inputStr.length > 900 ? inputStr.slice(0, 900) + "\n..." : inputStr;
    } catch {
      inputDisplay = String(toolInput);
    }

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle("Permission Request")
      .setDescription(`Claude wants to execute: **${toolName}**`)
      .addFields({
        name: "Input",
        value: "```json\n" + inputDisplay + "\n```",
      })
      .setColor(0xffa500)
      .setFooter({
        text: this.config.allowedUsers.length > 0
          ? `Respond within ${this.config.permissionTimeoutMs / 1000} seconds (authorized users only)`
          : `Respond within ${this.config.permissionTimeoutMs / 1000} seconds`,
      })
      .setTimestamp();

    // Create buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm_approve_${toolUseId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
        .setEmoji("\u2705"),
      new ButtonBuilder()
        .setCustomId(`perm_deny_${toolUseId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("\u274C")
    );

    const discordMsg = await channel.send({
      embeds: [embed],
      components: [row],
    });

    // Set up pending approval IMMEDIATELY — before reactions, so fast button
    // clicks don't hit the race window.
    const approvalPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(toolUseId);

        // Update message to show timeout
        const timeoutEmbed = EmbedBuilder.from(embed)
          .setColor(0x808080)
          .setFooter({ text: "Request timed out - denied by default" });

        discordMsg
          .edit({ embeds: [timeoutEmbed], components: [] })
          .catch(() => {});

        resolve(false);
      }, this.config.permissionTimeoutMs);

      this.pendingApprovals.set(toolUseId, {
        toolUseId,
        toolName,
        toolInput,
        discordMessageId: discordMsg.id,
        channelId: channel.id,
        resolve: (approved: boolean, byUserId?: string, cancelledText?: string) => {
          clearTimeout(timeout);
          this.pendingApprovals.delete(toolUseId);

          const decision = cancelledText ?? (approved ? "Approved" : "Denied");
          this.logger.info('🔒 PERMISSION', `${decision}: ${toolName}`, byUserId ? `by ${byUserId}` : undefined);

          // Update message to show decision
          const resultEmbed = EmbedBuilder.from(embed)
            .setColor(cancelledText ? 0x808080 : approved ? 0x00ff00 : 0xff0000)
            .setFooter({ text: byUserId ? `${decision} by user ${byUserId}` : decision });

          discordMsg
            .edit({ embeds: [resultEmbed], components: [] })
            .catch(() => {});

          resolve(approved);
        },
        timeout,
      });
    });

    // If the query is aborted (/clear, /rewind), stop waiting
    const onAbort = () =>
      this.pendingApprovals.get(toolUseId)?.resolve(false, undefined, "Cancelled — query aborted");
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    // Add fallback reactions (fire-and-forget — buttons are primary)
    discordMsg.react("\u2705").catch(() => {});
    discordMsg.react("\u274C").catch(() => {});

    return approvalPromise;
  }

  async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (!customId.startsWith("perm_")) {
      return;
    }

    const parts = customId.split("_");
    const action = parts[1]; // "approve" or "deny"
    const toolUseId = parts.slice(2).join("_");

    const pending = this.pendingApprovals.get(toolUseId);

    if (!pending) {
      await interaction.reply({
        content: "This permission request has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isUserAllowed(this.config, interaction.user.id)) {
      this.logger.warn('🔒 PERMISSION', `Ignored ${action} from unauthorized user`, interaction.user.id);
      await interaction.reply({
        content: "You're not authorized to approve or deny tool requests.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    pending.resolve(action === "approve", interaction.user.id);
  }

  handleReaction(messageId: string, emoji: string, userId: string): void {
    if (!isUserAllowed(this.config, userId)) {
      return;
    }

    // Find pending approval by message ID
    for (const pending of this.pendingApprovals.values()) {
      if (pending.discordMessageId === messageId) {
        if (emoji === "\u2705") {
          pending.resolve(true, userId);
        } else if (emoji === "\u274C") {
          pending.resolve(false, userId);
        }
        break;
      }
    }
  }

  cancelPendingApprovals(channelId: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.channelId !== channelId) continue;
      pending.resolve(false, undefined, "Cancelled — query finished");
    }
  }
}
