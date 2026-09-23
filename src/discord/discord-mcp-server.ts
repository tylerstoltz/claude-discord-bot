import { Client, ChannelType, type Guild, type GuildTextBasedChannel } from "discord.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isChannelAllowed, type BotConfig } from "../config.js";

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function channelTypeName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText: return "text";
    case ChannelType.GuildVoice: return "voice";
    case ChannelType.GuildCategory: return "category";
    case ChannelType.GuildAnnouncement: return "announcement";
    case ChannelType.GuildForum: return "forum";
    case ChannelType.GuildStageVoice: return "stage";
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread: return "thread";
    default: return "other";
  }
}

export function createDiscordMcpServer(client: Client, config: BotConfig): McpSdkServerConfigWithInstance {
  function resolveGuild(guildId?: string): Guild | undefined {
    const id = guildId || config.guildId;
    return id ? client.guilds.cache.get(id) : client.guilds.cache.first();
  }

  /** Fetch a guild text channel (or thread) that the bot is configured to see. */
  async function resolveTextChannel(channelId: string): Promise<GuildTextBasedChannel | string> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      return `Error: Channel ${channelId} not found or is not a server text channel.`;
    }
    const parentId = channel.isThread() ? channel.parentId : null;
    if (!isChannelAllowed(config, channel.id, parentId)) {
      return `Error: Channel ${channelId} is outside this bot's allowed channels.`;
    }
    return channel;
  }

  const fetchMessages = tool(
    "discord_fetch_messages",
    "Fetch recent messages from a Discord channel. Returns messages in reverse chronological order (newest first). Use before_message_id for pagination to fetch older messages.",
    {
      channel_id: z.string().describe("The Discord channel ID to fetch messages from"),
      limit: z.number().min(1).max(100).optional().describe("Number of messages to fetch (default 25, max 100)"),
      before_message_id: z.string().optional().describe("Fetch messages before this message ID (for pagination)"),
    },
    async (args) => {
      try {
        const channel = await resolveTextChannel(args.channel_id);
        if (typeof channel === "string") {
          return { content: [{ type: "text", text: channel }], isError: true };
        }

        const fetchOptions: { limit: number; before?: string } = {
          limit: args.limit ?? 25,
        };
        if (args.before_message_id) {
          fetchOptions.before = args.before_message_id;
        }

        const messages = await channel.messages.fetch(fetchOptions);

        if (messages.size === 0) {
          return { content: [{ type: "text", text: `#${channel.name} (ID: ${channel.id}) — No messages found.` }] };
        }

        const sorted = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        const lines = sorted.map((m) => {
          const time = formatTimestamp(m.createdAt);
          const author = m.author.displayName || m.author.username;
          const attachments = m.attachments.size > 0 ? ` [${m.attachments.size} attachment(s)]` : "";
          const embeds = m.embeds.length > 0 ? ` [${m.embeds.length} embed(s)]` : "";
          return `[${time}] ${author}: ${m.content || "(no text content)"}${attachments}${embeds}`;
        });

        const header = `#${channel.name} (ID: ${channel.id}) — Last ${sorted.length} messages:\n`;
        return { content: [{ type: "text", text: header + lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error fetching messages: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  const listChannels = tool(
    "discord_list_channels",
    "List all channels in a Discord server/guild. Returns channel names, IDs, types, and topics.",
    {
      guild_id: z.string().optional().describe("The guild/server ID (defaults to first guild the bot is in)"),
    },
    async (args) => {
      try {
        const guild = resolveGuild(args.guild_id);
        if (!guild) {
          return { content: [{ type: "text", text: "Error: No guild found. Provide a valid guild_id." }], isError: true };
        }

        const channels = await guild.channels.fetch();
        const sorted = [...channels.values()]
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .filter((c) => c.type === ChannelType.GuildCategory || isChannelAllowed(config, c.id))
          .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

        const lines = sorted.map((c) => {
          const topic = "topic" in c && c.topic ? ` — ${c.topic}` : "";
          return `${channelTypeName(c.type).padEnd(13)} #${c.name.padEnd(30)} (ID: ${c.id})${topic}`;
        });

        const header = `${guild.name} — ${sorted.length} channels:\n\n`;
        return { content: [{ type: "text", text: header + lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing channels: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  const serverInfo = tool(
    "discord_server_info",
    "Get metadata about a Discord server/guild including name, member count, creation date, roles, and owner.",
    {
      guild_id: z.string().optional().describe("The guild/server ID (defaults to first guild the bot is in)"),
    },
    async (args) => {
      try {
        const guild = resolveGuild(args.guild_id);
        if (!guild) {
          return { content: [{ type: "text", text: "Error: No guild found. Provide a valid guild_id." }], isError: true };
        }

        // Fetch full guild data
        const fetched = await guild.fetch();
        const owner = await fetched.fetchOwner();

        const roles = fetched.roles.cache
          .filter((r) => r.name !== "@everyone")
          .sort((a, b) => b.position - a.position)
          .map((r) => r.name);

        const info = [
          `Server: ${fetched.name}`,
          `ID: ${fetched.id}`,
          `Owner: ${owner.user.username}`,
          `Members: ${fetched.memberCount}`,
          `Created: ${formatTimestamp(fetched.createdAt)}`,
          `Boost level: ${fetched.premiumTier}`,
          `Boosts: ${fetched.premiumSubscriptionCount ?? 0}`,
          `Roles (${roles.length}): ${roles.join(", ")}`,
        ];

        return { content: [{ type: "text", text: info.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error fetching server info: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  const searchMessages = tool(
    "discord_search_messages",
    "Search messages in a Discord channel by keyword. Fetches recent messages and filters client-side. For deeper history, use before_message_id to paginate.",
    {
      channel_id: z.string().describe("The Discord channel ID to search in"),
      query: z.string().describe("Search keyword or phrase (case-insensitive)"),
      limit: z.number().min(1).max(100).optional().describe("Number of messages to scan (default 50, max 100)"),
      before_message_id: z.string().optional().describe("Scan messages before this message ID (for paginating further back)"),
    },
    async (args) => {
      try {
        const channel = await resolveTextChannel(args.channel_id);
        if (typeof channel === "string") {
          return { content: [{ type: "text", text: channel }], isError: true };
        }

        const messages = await channel.messages.fetch({ limit: args.limit ?? 50, before: args.before_message_id });
        const queryLower = args.query.toLowerCase();
        const matches = [...messages.values()]
          .filter((m) => m.content.toLowerCase().includes(queryLower))
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No messages matching "${args.query}" in #${channel.name} (searched ${messages.size} messages).` }] };
        }

        const lines = matches.map((m) => {
          const time = formatTimestamp(m.createdAt);
          const author = m.author.displayName || m.author.username;
          return `[${time}] ${author}: ${m.content}`;
        });

        const oldest = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
        const header = `#${channel.name} — ${matches.length} match(es) for "${args.query}" (searched ${messages.size} messages; oldest scanned ID: ${oldest?.id}):\n\n`;
        return { content: [{ type: "text", text: header + lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error searching messages: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  return createSdkMcpServer({
    name: "discord",
    version: "1.0.0",
    tools: [fetchMessages, listChannels, serverInfo, searchMessages],
  });
}
