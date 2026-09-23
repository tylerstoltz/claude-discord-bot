import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  REST,
  Routes,
} from "discord.js";
import { isChannelAllowed, isUserAllowed, type BotConfig } from "../config.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { Logger } from "../logging/logger.js";
import { refreshSystemPrompt } from "../agent/ai-client.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Summarize the conversation so far to free up context"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the current session and start fresh"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current session status"),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Rewind the conversation by removing recent exchanges")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Number of message exchanges to remove (default: 1)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50)
    ),
];

export async function registerCommands(token: string, clientId: string, logger: Logger, guildId?: string): Promise<void> {
  const rest = new REST().setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const scope = guildId ? `guild ${guildId.slice(-6)}` : 'global';

  try {
    await rest.put(route, {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    logger.info('🤖 BOT', `Slash commands registered (${scope})`);
  } catch (error) {
    logger.error('🤖 BOT', 'Failed to register slash commands', (error as Error).message);
  }
}

export class SlashCommandHandler {
  constructor(
    private config: BotConfig,
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = interaction.channelId;
    const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : null;

    if (
      !isUserAllowed(this.config, interaction.user.id) ||
      !isChannelAllowed(this.config, channelId, parentId)
    ) {
      await interaction.reply({
        content: "You can't use this bot's commands here.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.logger.channelActivity(channelId, `/${interaction.commandName}`, `by ${interaction.user.id}`);

    switch (interaction.commandName) {
      case "compact":
        await this.handleCompact(interaction, channelId);
        break;
      case "clear":
        await this.handleClear(interaction, channelId);
        break;
      case "status":
        await this.handleStatus(interaction, channelId);
        break;
      case "rewind":
        await this.handleRewind(interaction, channelId);
        break;
      default:
        await interaction.reply({
          content: "Unknown command.",
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async handleCompact(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    await interaction.deferReply();

    // Runs in the channel queue, after any reply in progress
    const result = await this.sessionManager.runExclusive(channelId, () =>
      this.sessionManager.compactSession(channelId)
    );

    if (!result.compacted) {
      await interaction.editReply(`❌ Couldn't compact: ${result.error}`);
      return;
    }

    const tokens = result.postTokens !== undefined
      ? `**${result.preTokens}** → **${result.postTokens}** tokens`
      : `**${result.preTokens}** tokens summarized`;
    await interaction.editReply(
      `🗜️ **Conversation compacted** (${tokens})\n\n` +
      `💡 Your next message continues from the summary. Earlier exchanges can no longer be rewound.`
    );
  }

  private async handleClear(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    // Clearing waits for any running reply to stop, which can exceed Discord's 3s reply window
    await interaction.deferReply();
    await this.sessionManager.clearSession(channelId);
    refreshSystemPrompt();
    await interaction.editReply("Session cleared. Starting fresh conversation.");
  }

  private async handleStatus(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    const session = this.sessionManager.getActiveSession(channelId);

    if (!session) {
      await interaction.reply({
        content: "No active session in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = [
      `**Session Status**`,
      `- Session ID: \`${session.sdkSessionId || "Not started"}\``,
      `- Processing: ${session.isProcessing ? "Yes" : "No"}${session.queued > 0 ? ` (${session.queued} queued)` : ""}`,
      `- Rewindable exchanges: ${this.sessionManager.getTurnCount(channelId)}`,
      ...(this.sessionManager.hasPendingRewind(channelId) ? [`- Rewound: next message continues from an earlier point`] : []),
      `- Last Activity: ${session.lastActivity.toLocaleString()}`,
    ].join("\n");

    await interaction.reply({ content: status, flags: MessageFlags.Ephemeral });
  }

  private async handleRewind(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    await interaction.deferReply();

    const count = interaction.options.getInteger("count") || 1;

    const result = await this.sessionManager.rewindSession(channelId, count);

    if (!result.success) {
      await interaction.editReply("❌ No active session to rewind.");
      return;
    }

    if (result.removed === 0) {
      await interaction.editReply("⚠️ Nothing to rewind (no recorded exchanges since the session started or was last compacted).");
      return;
    }

    let message = `⏪ **Rewound conversation**\n\n`;
    message += `• Removed the last **${result.removed}** exchange${result.removed > 1 ? 's' : ''}\n`;

    if (result.remaining > 0) {
      message += `\n💡 Your next message continues from the earlier point in the conversation.`;
    } else {
      message += `• Session reset to the beginning\n`;
      message += `\n💡 Your next message will start a fresh conversation.`;
    }

    await interaction.editReply(message);
  }
}
