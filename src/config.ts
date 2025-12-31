import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface BotConfig {
  discordToken: string;
  monitorMentions: boolean;
  monitorAllMessages: boolean;
  allowedChannels: string[];
  maxMessageLength: number;
  model: "sonnet" | "opus" | "haiku";
  allowedTools: string[];
  dangerousTools: string[];
  updateIntervalMs: number;
  sessionPersistPath: string;
  randomMessagesEnabled: boolean;
  randomMessageInterval: number;
  randomMessageChannels: string[];
  randomMessagePrompt: string;
  permissionTimeoutMs: number;
}

const defaultConfig: BotConfig = {
  discordToken: "",
  monitorMentions: true,
  monitorAllMessages: false,
  allowedChannels: [],
  maxMessageLength: 2000,
  model: "sonnet",
  allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  dangerousTools: ["Bash", "Write", "Edit", "MultiEdit"],
  updateIntervalMs: 3000,
  sessionPersistPath: "./data/sessions.json",
  randomMessagesEnabled: false,
  randomMessageInterval: 60,
  randomMessageChannels: [],
  randomMessagePrompt: "Share something interesting or helpful.",
  permissionTimeoutMs: 60000,
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
