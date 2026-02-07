import { loadConfig } from "./config.js";
import { DiscordBot } from "./bot/discord-client.js";

// Safety net: suppress known SDK transport errors that can surface as unhandled
// rejections when a query is aborted mid-flight (e.g., /clear during processing).
const SDK_TRANSPORT_ERRORS = [
  "ProcessTransport is not ready",
  "Cannot write to terminated process",
];

function isKnownTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;
  return (
    SDK_TRANSPORT_ERRORS.some((pattern) => message.includes(pattern)) ||
    code === "EPIPE"
  );
}

process.on("unhandledRejection", (reason) => {
  if (isKnownTransportError(reason)) {
    console.warn("[WARN] Suppressed SDK transport error (likely from aborted query):", (reason as Error).message);
    return;
  }
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  if (isKnownTransportError(error)) {
    console.warn("[WARN] Suppressed SDK transport error (likely from aborted query):", error.message);
    return;
  }
  console.error("Uncaught exception:", error);
  process.exit(1);
});

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
