import { loadConfig } from "./config.js";
import { DiscordBot } from "./bot/discord-client.js";

async function main() {
  console.log("Starting Claude Discord Bot...");

  const config = loadConfig();
  console.log(`Loaded config: monitoring mentions=${config.monitorMentions}, model=${config.model}`);

  const bot = new DiscordBot(config);

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await bot.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\nShutting down...");
    await bot.shutdown();
    process.exit(0);
  });

  await bot.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
