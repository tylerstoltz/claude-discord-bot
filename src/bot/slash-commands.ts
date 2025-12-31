import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
} from "discord.js";
import type { SessionManager } from "../agent/session-manager.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Summarize and compact the current conversation context"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the current session and start fresh"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current session status"),
];

export async function registerCommands(token: string, clientId: string): Promise<void> {
  const rest = new REST().setToken(token);

  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}

export class SlashCommandHandler {
  constructor(private sessionManager: SessionManager) {}

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

    const session = this.sessionManager.getActiveSession(channelId);

    if (!session?.sdkSessionId) {
      await interaction.editReply("No active session to compact.");
      return;
    }

    // The SDK handles compaction through the session
    // For now, we'll inform the user - full compaction would require
    // sending a special prompt or using SDK methods if available
    await interaction.editReply(
      "Session context noted. The next message will continue with the current context. " +
        "For a fresh start, use `/clear`."
    );
  }

  private async handleClear(
    interaction: ChatInputCommandInteraction,
    channelId: string
  ): Promise<void> {
    await this.sessionManager.clearSession(channelId);
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
}
