import {
  Client,
  GatewayIntentBits,
  Events,
  Interaction,
  Message,
  MessageFlags,
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
import { Logger } from "../logging/logger.js";
import { ActivityManager } from "./activity-manager.js";
import { createDiscordMcpServer } from "../discord/discord-mcp-server.js";

export class DiscordBot {
  private client: Client;
  private sessionManager: SessionManager;
  private messageHandler?: MessageHandler;
  private slashCommandHandler?: SlashCommandHandler;
  private permissionHook?: PermissionHook;
  private logger: Logger;

  constructor(private config: BotConfig) {
    this.logger = new Logger(config.logLevel, config.logTimestamps, config.logColors);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.sessionManager = new SessionManager(config, this.logger);

    this.setupEventHandlers();
  }

  /**
   * Wrap an async event handler so a failure is logged instead of becoming an
   * unhandled rejection (which exits the process).
   */
  private guard<A extends unknown[]>(name: string, handler: (...args: A) => Promise<void>) {
    return (...args: A): void => {
      handler(...args).catch((error) => {
        this.logger.error('🤖 BOT', `Unhandled error in ${name} handler`, (error as Error)?.stack || String(error));
      });
    };
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, this.guard('ready', async (readyClient: Client<true>) => {
      this.logger.info('🤖 BOT', `Logged in as ${readyClient.user.tag}`);

      const activityManager = new ActivityManager(this.client);
      activityManager.setStatus('idle', true);

      this.permissionHook = new PermissionHook(
        this.config,
        (channelId) => this.client.channels.cache.get(channelId) as any,
        this.logger
      );
      this.sessionManager.setPermissionHook(this.permissionHook);

      // Create Discord MCP server for channel/message query tools
      this.sessionManager.setDiscordMcpServer(createDiscordMcpServer(this.client, this.config));
      this.logger.info('🤖 BOT', 'Discord MCP server initialized');

      this.slashCommandHandler = new SlashCommandHandler(this.config, this.sessionManager, this.logger);

      // Register slash commands
      await registerCommands(this.config.discordToken, readyClient.user.id, this.logger, this.config.guildId);

      // Accept messages last, once everything above is ready
      this.messageHandler = new MessageHandler(
        this.config,
        this.sessionManager,
        readyClient.user.id,
        this.logger,
        activityManager
      );

      this.logger.info('🤖 BOT', 'Ready to receive messages');
    }));

    this.client.on(Events.MessageCreate, this.guard('message', async (message: Message) => {
      await this.messageHandler?.handleMessage(message);
    }));

    this.client.on(Events.InteractionCreate, this.guard('interaction', async (interaction: Interaction) => {
      try {
        if (interaction.isChatInputCommand() && this.slashCommandHandler) {
          await this.slashCommandHandler.handleInteraction(interaction);
        } else if (interaction.isButton() && this.permissionHook) {
          await this.permissionHook.handleButtonInteraction(interaction);
        }
      } catch (error) {
        // Tell the user something went wrong, if the interaction is still answerable
        if (interaction.isRepliable()) {
          const reply = { content: `❌ Error: ${(error as Error).message}`, flags: MessageFlags.Ephemeral } as const;
          const send = interaction.deferred || interaction.replied
            ? interaction.followUp(reply)
            : interaction.reply(reply);
          await send.catch(() => {});
        }
        throw error;
      }
    }));

    this.client.on(
      Events.MessageReactionAdd,
      this.guard('reaction', async (
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

        this.permissionHook?.handleReaction(
          reaction.message.id,
          reaction.emoji.name || "",
          user.id
        );
      })
    );

    this.client.on(Events.Error, (error) => {
      this.logger.error('🤖 BOT', 'Discord client error', error.message);
    });
  }

  async start(): Promise<void> {
    if (this.config.allowedUsers.length === 0) {
      this.logger.warn(
        '🔒 ACCESS',
        'allowedUsers is empty: ANYONE who can message the bot can use it and approve tool calls. ' +
        'Set allowedUsers in config.json to your Discord user ID(s).'
      );
    }

    // Load persisted sessions before any message can arrive
    await this.sessionManager.loadPersistedSessions();

    this.logger.info('🤖 BOT', 'Connecting to Discord...');
    await this.client.login(this.config.discordToken);
  }

  async shutdown(): Promise<void> {
    this.logger.info('🤖 BOT', 'Saving sessions...');
    await this.sessionManager.persistSessions();
    this.logger.info('🤖 BOT', 'Disconnecting...');
    await this.client.destroy();
  }
}
