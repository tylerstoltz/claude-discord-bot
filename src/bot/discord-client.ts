import {
  Client,
  GatewayIntentBits,
  Events,
  Interaction,
  Message,
  MessageReaction,
  User,
  PartialMessageReaction,
  PartialUser,
} from "discord.js";
import type { BotConfig } from "../config.js";
import { SessionManager } from "../agent/session-manager.js";
import { MessageHandler } from "./message-handler.js";
import { SlashCommandHandler, registerCommands } from "./slash-commands.js";
import { PermissionHook } from "../agent/permission-hook.js";

export class DiscordBot {
  private client: Client;
  private sessionManager: SessionManager;
  private messageHandler!: MessageHandler;
  private slashCommandHandler!: SlashCommandHandler;
  private permissionHook!: PermissionHook;

  constructor(private config: BotConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.sessionManager = new SessionManager(config);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`[BOT] Logged in as ${readyClient.user.tag}`);

      // Initialize components that need the bot user ID
      this.permissionHook = new PermissionHook(
        this.config,
        (channelId) => this.client.channels.cache.get(channelId) as any
      );

      this.sessionManager.setPermissionHook(this.permissionHook);

      this.messageHandler = new MessageHandler(
        this.config,
        this.sessionManager,
        readyClient.user.id
      );

      this.slashCommandHandler = new SlashCommandHandler(this.sessionManager);

      // Register slash commands
      await registerCommands(this.config.discordToken, readyClient.user.id);

      // Load persisted sessions
      await this.sessionManager.loadPersistedSessions();

      console.log("[BOT] Ready to receive messages.");
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (this.messageHandler) {
        await this.messageHandler.handleMessage(message);
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.isChatInputCommand() && this.slashCommandHandler) {
        await this.slashCommandHandler.handleInteraction(interaction);
      }

      if (interaction.isButton() && this.permissionHook) {
        await this.permissionHook.handleButtonInteraction(interaction);
      }
    });

    this.client.on(
      Events.MessageReactionAdd,
      async (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
      ) => {
        if (user.bot) return;

        // Fetch partial reaction if needed
        if (reaction.partial) {
          try {
            await reaction.fetch();
          } catch {
            return;
          }
        }

        if (this.permissionHook) {
          this.permissionHook.handleReaction(
            reaction.message.id,
            reaction.emoji.name || "",
            user.id
          );
        }
      }
    );

    this.client.on(Events.Error, (error) => {
      console.error("[BOT] Discord client error:", error);
    });
  }

  async start(): Promise<void> {
    console.log("[BOT] Connecting to Discord...");
    await this.client.login(this.config.discordToken);
  }

  async shutdown(): Promise<void> {
    console.log("[BOT] Saving sessions...");
    await this.sessionManager.persistSessions();
    console.log("[BOT] Disconnecting...");
    this.client.destroy();
  }

  getClient(): Client {
    return this.client;
  }
}
