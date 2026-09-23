import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { LogLevel } from "./logging/logger.js";

export interface BotConfig {
  discordToken: string;
  monitorMentions: boolean;
  monitorAllMessages: boolean;
  allowedChannels: string[];
  // Discord user IDs allowed to talk to the bot, run slash commands, and approve
  // dangerous tools. Empty = anyone (not recommended; a warning is logged at startup).
  allowedUsers: string[];
  maxMessageLength: number;
  model: "sonnet" | "opus" | "haiku";
  enableChrome: boolean;
  allowedTools: string[];
  dangerousTools: string[];
  updateIntervalMs: number;
  sessionPersistPath: string;
  permissionTimeoutMs: number;
  // Messages that arrive while a channel is busy are queued (⏳) up to this many.
  maxQueuedMessages: number;

  // Logging configuration
  logLevel: LogLevel;
  logTimestamps: boolean;
  logColors: boolean;

  // Guild ID for faster slash command registration (optional)
  guildId?: string;

  // Attachment configuration
  attachments: {
    enabled: boolean;
    maxImageSize: number;
    supportedImageTypes: string[];
  };

  // File upload configuration (Claude -> Discord)
  fileUpload: {
    enabled: boolean;
    autoUpload: boolean;
    maxFileSize: number;
    allowedExtensions: string[];
    // Directories (relative to the bot's cwd, or absolute) that files may be
    // uploaded from. Empty = anywhere. Bot secrets are always blocked.
    allowedDirs: string[];
  };
}

export const defaultConfig: BotConfig = {
  discordToken: "",
  monitorMentions: true,
  monitorAllMessages: false,
  allowedChannels: [],
  allowedUsers: [],
  maxMessageLength: 2000,
  model: "sonnet",
  enableChrome: false,
  allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  dangerousTools: ["Bash", "Write", "Edit", "MultiEdit"],
  updateIntervalMs: 3000,
  sessionPersistPath: "./data/sessions.json",
  permissionTimeoutMs: 60000,
  maxQueuedMessages: 5,

  // Logging defaults
  logLevel: "info",
  logTimestamps: true,
  logColors: true,

  // Attachment defaults
  attachments: {
    enabled: true,
    maxImageSize: 5 * 1024 * 1024, // 5 MB
    supportedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"]
  },

  // File upload defaults (Claude -> Discord)
  fileUpload: {
    enabled: true,
    autoUpload: true,
    maxFileSize: 25 * 1024 * 1024, // 25 MB (Discord free tier limit)
    allowedExtensions: [".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log", ".svg", ".html", ".xml", ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"],
    allowedDirs: ["./playground"]
  }
};

/** Merge user config over defaults. Nested sections are merged one level deep. */
export function mergeConfig(userConfig: Partial<BotConfig>): BotConfig {
  return {
    ...defaultConfig,
    ...userConfig,
    attachments: { ...defaultConfig.attachments, ...userConfig.attachments },
    fileUpload: { ...defaultConfig.fileUpload, ...userConfig.fileUpload },
  };
}

export function loadConfig(configPath?: string): BotConfig {
  const path = configPath || process.env.BOT_CONFIG_PATH || "./config.json";
  const resolvedPath = resolve(path);

  if (!existsSync(resolvedPath)) {
    console.error(`Config file not found: ${resolvedPath}`);
    console.error("Please create a config.json file with your Discord token.");
    process.exit(1);
  }

  try {
    const fileContent = readFileSync(resolvedPath, "utf-8");
    const config = mergeConfig(JSON.parse(fileContent));

    if (!config.discordToken) {
      console.error("Discord token is required in config.json");
      process.exit(1);
    }

    return config;
  } catch (error) {
    console.error(`Failed to load config: ${error}`);
    process.exit(1);
  }
}

export function isUserAllowed(config: BotConfig, userId: string): boolean {
  return config.allowedUsers.length === 0 || config.allowedUsers.includes(userId);
}

/** A thread counts as allowed when its parent channel is allowed. */
export function isChannelAllowed(config: BotConfig, channelId: string, parentId?: string | null): boolean {
  if (config.allowedChannels.length === 0) return true;
  return (
    config.allowedChannels.includes(channelId) ||
    (!!parentId && config.allowedChannels.includes(parentId))
  );
}
