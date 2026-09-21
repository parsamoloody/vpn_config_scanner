import { getConfig } from "./config/env.js";
import { initDatabase, closeDatabase } from "./database/db.js";
import { ChannelRepository } from "./database/repositories/channel.repo.js";
import { ConfigRepository } from "./database/repositories/config.repo.js";
import { SettingsRepository } from "./database/repositories/settings.repo.js";
import { logger } from "./logger.js";
import { ScanOrchestrator } from "./scheduler/orchestrator.js";
import { TelegramBotService } from "./telegram/bot.js";
import { initTelegramClient, disconnectTelegramClient } from "./telegram/client.js";
import { TesterPool } from "./tester/pool.js";

async function main() {
  logger.info("Initializing Telegram VPN Config Monitor Bot...");

  let config;
  try {
    config = getConfig();
  } catch (err: any) {
    logger.fatal(err.message);
    process.exit(1);
  }

  // 1. Initialize Database
  initDatabase(config.DATABASE_PATH);
  const channelRepo = new ChannelRepository();
  const configRepo = new ConfigRepository();
  const settingsRepo = new SettingsRepository(config);

  // 2. Initialize Telegram MTProto Client
  const client = await initTelegramClient(config);

  // 3. Initialize Tester Pool
  const testerPool = new TesterPool(config);
  await testerPool.init();

  // 4. Start Scan Orchestrator
  const orchestrator = new ScanOrchestrator(
    client,
    channelRepo,
    configRepo,
    testerPool,
    config,
    settingsRepo
  );
  orchestrator.start();

  // 5. Start Optional Bot Command Service
  const botService = new TelegramBotService(
    config,
    channelRepo,
    configRepo,
    orchestrator,
    settingsRepo
  );
  await botService.start();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Graceful shutdown initiated...");
    botService.stop();
    orchestrator.stop();
    await disconnectTelegramClient();
    closeDatabase();
    logger.info("Shutdown complete. Bye!");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "Fatal application error on startup");
  process.exit(1);
});
