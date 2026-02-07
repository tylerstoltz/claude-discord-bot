import {
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
} from "discord.js";
import type { BotConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";

interface PendingApproval {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  discordMessageId: string;
  channelId: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class PermissionHook {
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    private config: BotConfig,
    private getChannel: (channelId: string) => TextChannel | null,
    private logger: Logger
  ) {}

  createHookHandler(channelId: string) {
    return async (
      input: { tool_name: string; tool_input: unknown },
      toolUseId?: string
    ): Promise<{
      continue?: boolean;
      hookSpecificOutput?: {
        hookEventName: 'PreToolUse';
        permissionDecision?: 'allow' | 'deny';
        permissionDecisionReason?: string;
      };
    }> => {
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // Check if this is a dangerous tool
      if (!this.config.dangerousTools.includes(toolName)) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      const channel = this.getChannel(channelId);
      if (!channel) {
        this.logger.error('🔒 PERMISSION', `Channel ${channelId.slice(-6)} not found`);
        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Cannot request permission: channel not found'
          }
        };
      }

      const id = toolUseId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      this.logger.info('🔒 PERMISSION', `Requesting approval for ${toolName}`, `ID: ${id.slice(0, 8)}`);

      const approved = await this.requestApproval(channel, toolName, toolInput, id);

      this.logger.info('🔒 PERMISSION', `Approval result for ${toolName}: ${approved}`, `ID: ${id.slice(0, 8)}`);

      if (approved) {
        this.logger.info('🔒 PERMISSION', `Approved: ${toolName}`);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      } else {
        this.logger.warn('🔒 PERMISSION', `Denied: ${toolName}`);
        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'User denied permission for this operation'
          }
        };
      }
    };
  }

  private async requestApproval(
    channel: TextChannel,
    toolName: string,
    toolInput: unknown,
    toolUseId: string
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
        text: `Respond within ${this.config.permissionTimeoutMs / 1000} seconds`,
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

    // Also add reactions as fallback
    await discordMsg.react("\u2705");
    await discordMsg.react("\u274C");

    return new Promise((resolve) => {
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
        resolve: (approved: boolean) => {
          clearTimeout(timeout);
          this.pendingApprovals.delete(toolUseId);

          // Update message to show decision
          const resultEmbed = EmbedBuilder.from(embed)
            .setColor(approved ? 0x00ff00 : 0xff0000)
            .setFooter({ text: approved ? "Approved" : "Denied" });

          discordMsg
            .edit({ embeds: [resultEmbed], components: [] })
            .catch(() => {});

          resolve(approved);
        },
        timeout,
      });
    });
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
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();
    pending.resolve(action === "approve");
  }

  handleReaction(messageId: string, emoji: string, userId: string): void {
    // Find pending approval by message ID
    for (const pending of this.pendingApprovals.values()) {
      if (pending.discordMessageId === messageId) {
        if (emoji === "\u2705" || emoji === "✅") {
          pending.resolve(true);
        } else if (emoji === "\u274C" || emoji === "❌") {
          pending.resolve(false);
        }
        break;
      }
    }
  }
}
