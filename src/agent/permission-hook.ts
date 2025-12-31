import {
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
} from "discord.js";
import type { BotConfig } from "../config.js";

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
    private getChannel: (channelId: string) => TextChannel | null
  ) {}

  createHookHandler(channelId: string) {
    return async (
      input: { tool_name: string; tool_input: unknown },
      toolUseId?: string
    ): Promise<{ continue?: boolean; decision?: string; stopReason?: string }> => {
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // Check if this is a dangerous tool
      if (!this.config.dangerousTools.includes(toolName)) {
        return { continue: true };
      }

      const channel = this.getChannel(channelId);
      if (!channel) {
        console.error(`[PERMISSION] Channel ${channelId} not found`);
        return {
          decision: "block",
          stopReason: "Cannot request permission: channel not found",
          continue: false,
        };
      }

      const id = toolUseId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      console.log(`[PERMISSION] Requesting approval for ${toolName} (${id})`);

      const approved = await this.requestApproval(channel, toolName, toolInput, id);

      if (approved) {
        console.log(`[PERMISSION] Approved: ${toolName}`);
        return { decision: "approve", continue: true };
      } else {
        console.log(`[PERMISSION] Denied: ${toolName}`);
        return {
          decision: "block",
          stopReason: "User denied permission for this operation",
          continue: false,
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
