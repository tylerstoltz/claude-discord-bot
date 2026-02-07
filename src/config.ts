import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { LogLevel } from "./logging/logger.js";

export interface BotConfig {
  discordToken: string;
  monitorMentions: boolean;
  monitorAllMessages: boolean;
  allowedChannels: string[];
  maxMessageLength: number;
  model: "sonnet" | "opus" | "haiku";
  enableChrome: boolean;
  allowedTools: string[];
  dangerousTools: string[];
  updateIntervalMs: number;
  sessionPersistPath: string;
  randomMessagesEnabled: boolean;
  randomMessageInterval: number;
  randomMessageChannels: string[];
  randomMessagePrompt: string;
  permissionTimeoutMs: number;

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
  };
}

const defaultConfig: BotConfig = {
  discordToken: "",
  monitorMentions: true,
  monitorAllMessages: false,
  allowedChannels: [],
  maxMessageLength: 2000,
  model: "sonnet",
  enableChrome: false,
  allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  dangerousTools: ["Bash", "Write", "Edit", "MultiEdit"],
  updateIntervalMs: 3000,
  sessionPersistPath: "./data/sessions.json",
  randomMessagesEnabled: false,
  randomMessageInterval: 60,
  randomMessageChannels: [],
  randomMessagePrompt: "Share something interesting or helpful.",
  permissionTimeoutMs: 60000,

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
    allowedExtensions: [".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log", ".svg", ".html", ".xml", ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"]
  }
};

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
    const userConfig = JSON.parse(fileContent);
    const config = { ...defaultConfig, ...userConfig };

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

export function isDangerousTool(toolName: string, config: BotConfig): boolean {
  return config.dangerousTools.includes(toolName);
}
