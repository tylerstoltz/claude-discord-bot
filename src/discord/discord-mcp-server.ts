import { Client, ChannelType, TextChannel, type Guild } from "discord.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
    default: return "other";
  }
}

function resolveGuild(client: Client, guildId?: string): Guild | undefined {
  if (guildId) {
    return client.guilds.cache.get(guildId);
  }
  return client.guilds.cache.first();
}

export function createDiscordMcpServer(client: Client): McpSdkServerConfigWithInstance {
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
        const channel = await client.channels.fetch(args.channel_id);
        if (!channel || !(channel instanceof TextChannel)) {
          return { content: [{ type: "text", text: `Error: Channel ${args.channel_id} not found or is not a text channel.` }], isError: true };
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
        const guild = resolveGuild(client, args.guild_id);
        if (!guild) {
          return { content: [{ type: "text", text: "Error: No guild found. Provide a valid guild_id." }], isError: true };
        }

        const channels = await guild.channels.fetch();
        const sorted = [...channels.values()]
          .filter((c): c is NonNullable<typeof c> => c !== null)
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
        const guild = resolveGuild(client, args.guild_id);
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
    },
    async (args) => {
      try {
        const channel = await client.channels.fetch(args.channel_id);
        if (!channel || !(channel instanceof TextChannel)) {
          return { content: [{ type: "text", text: `Error: Channel ${args.channel_id} not found or is not a text channel.` }], isError: true };
        }

        const messages = await channel.messages.fetch({ limit: args.limit ?? 50 });
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

        const header = `#${channel.name} — ${matches.length} match(es) for "${args.query}" (searched ${messages.size} messages):\n\n`;
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
