import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
} from "discord.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { Logger } from "../logging/logger.js";
import { refreshSystemPrompt } from "../agent/ai-client.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Show conversation context info (SDK auto-compacts when needed)"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the current session and start fresh"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current session status"),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Rewind the conversation by removing recent messages")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Number of message exchanges to remove (default: 1)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50)
    ),
];

export async function registerCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST().setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const scope = guildId ? `guild ${guildId.slice(-6)}` : 'global';

  try {
    console.log(`Registering slash commands (${scope})...`);
    await rest.put(route, {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log(`Slash commands registered successfully (${scope}).`);
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}

export class SlashCommandHandler {
  constructor(private sessionManager: SessionManager, private logger?: Logger) {}

  async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = interaction.channelId;

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
          ephemeral: true,
        });
    }
  }

  private async handleCompact(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    await interaction.deferReply();

    const result = await this.sessionManager.compactSession(channelId);

    if (!result.success) {
      await interaction.editReply("❌ No active session to show info for.");
      return;
    }

    await interaction.editReply(
      `📊 **Session Context Info**\n\n` +
      `• Messages in history: **${result.messageCount}**\n` +
      `• The SDK automatically compacts context when it grows large\n` +
      `• Use \`/clear\` for a fresh start, or \`/rewind\` to remove recent messages\n\n` +
      `💡 Your next message will continue with the current context.`
    );
  }

  private async handleClear(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    await this.sessionManager.clearSession(channelId);
    refreshSystemPrompt();
    await interaction.reply("Session cleared. Starting fresh conversation.");
  }

  private async handleStatus(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    const session = this.sessionManager.getActiveSession(channelId);

    if (!session) {
      await interaction.reply({
        content: "No active session in this channel.",
        ephemeral: true,
      });
      return;
    }

    const status = [
      `**Session Status**`,
      `- Session ID: \`${session.sdkSessionId || "Not started"}\``,
      `- Processing: ${session.isProcessing ? "Yes" : "No"}`,
      `- Last Activity: ${session.lastActivity.toLocaleString()}`,
    ].join("\n");

    await interaction.reply({ content: status, ephemeral: true });
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

    if (result.messagesRemoved === 0) {
      await interaction.editReply("⚠️ No messages to rewind. The session is already at the beginning.");
      return;
    }

    let message = `⏪ **Rewound conversation**\n\n`;
    message += `• Removed **${result.messagesRemoved}** message${result.messagesRemoved > 1 ? 's' : ''} from history\n`;

    if (result.rewoundTo) {
      message += `• Conversation reset to session: \`${result.rewoundTo.slice(0, 8)}...\`\n`;
      message += `\n💡 Your next message will continue from the earlier point in the conversation.`;
    } else {
      message += `• Session reset to the beginning\n`;
      message += `\n💡 Your next message will start a fresh conversation.`;
    }

    await interaction.editReply(message);
  }
}
