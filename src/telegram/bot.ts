import { Config } from "../config/env.js";
import { ChannelRepository } from "../database/repositories/channel.repo.js";
import { ConfigRepository } from "../database/repositories/config.repo.js";
import { logger } from "../logger.js";
import { ScanOrchestrator } from "../scheduler/orchestrator.js";

export class TelegramBotService {
  private config: Config;
  private channelRepo: ChannelRepository;
  private configRepo: ConfigRepository;
  private orchestrator: ScanOrchestrator;
  private isPolling = false;
  private lastUpdateId = 0;

  constructor(
    config: Config,
    channelRepo: ChannelRepository,
    configRepo: ConfigRepository,
    orchestrator: ScanOrchestrator
  ) {
    this.config = config;
    this.channelRepo = channelRepo;
    this.configRepo = configRepo;
    this.orchestrator = orchestrator;
  }

  async start(): Promise<void> {
    if (!this.config.TELEGRAM_BOT_TOKEN) {
      logger.info("No TELEGRAM_BOT_TOKEN provided. Bot command listener disabled.");
      return;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/getMe`);
      const data = (await res.json()) as any;
      if (!data.ok) {
        throw new Error(`Invalid bot token: ${data.description}`);
      }

      logger.info(
        { botUsername: `@${data.result.username}`, botName: data.result.first_name },
        "Telegram Bot Service initialized and listening for commands!"
      );

      this.isPolling = true;
      this.pollUpdates();
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to initialize Telegram Bot Service");
    }
  }

  stop(): void {
    this.isPolling = false;
  }

  private async pollUpdates(): Promise<void> {
    while (this.isPolling) {
      try {
        const url = `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${
          this.lastUpdateId + 1
        }&timeout=25`;
        const res = await fetch(url);
        const data = (await res.json()) as any;

        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            if (update.message && update.message.text) {
              await this.handleMessage(update.message);
            }
          }
        }
      } catch (err: any) {
        if (this.isPolling) {
          logger.debug({ err: err.message }, "Error during bot long-polling, retrying in 3s...");
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const fromId = msg.from?.id?.toString();

    // Check admin if configured
    if (this.config.ADMIN_USER_IDS.length > 0 && fromId && !this.config.ADMIN_USER_IDS.includes(fromId)) {
      await this.sendMessage(chatId, "⛔ You are not authorized to control this bot.");
      return;
    }

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await this.sendMessage(
        chatId,
        `🤖 *Telegram VPN Monitor Bot*\n\n` +
          `📡 *Target Channel:* \`${this.config.TARGET_CHANNEL_ID}\`\n` +
          `⏱️ *Scan Interval:* Every ${this.config.SCAN_INTERVAL_MINUTES} minutes\n` +
          `🏷️ *Remarks:* \`${this.config.CUSTOM_CONFIG_REMARKS}\`\n\n` +
          `*Available Commands:*\n` +
          `▶️ \`/scan\` - Trigger an immediate scan and test cycle\n` +
          `📊 \`/status\` - View database & monitoring statistics\n` +
          `📋 \`/channels\` - List monitored channels\n`
      );
    } else if (text.startsWith("/scan")) {
      await this.sendMessage(chatId, "🔍 Starting VPN scan & connectivity check cycle now...");
      this.orchestrator
        .runCycle()
        .then(() => {
          this.sendMessage(chatId, "✅ Scan and publishing cycle completed successfully!");
        })
        .catch((err) => {
          this.sendMessage(chatId, `❌ Error during scan cycle: ${err.message}`);
        });
    } else if (text.startsWith("/status")) {
      const allChannels = this.channelRepo.getAllChannels();
      const unposted = this.configRepo.getUnpostedHealthyConfigs(100);

      await this.sendMessage(
        chatId,
        `📊 *VPN Monitor Status*\n\n` +
          `📡 *Monitored Channels in DB:* ${allChannels.length}\n` +
          `🟢 *Unposted Healthy Configs:* ${unposted.length}\n` +
          `🎯 *Target Channel:* \`${this.config.TARGET_CHANNEL_ID}\`\n` +
          `⏱️ *Scheduler Interval:* ${this.config.SCAN_INTERVAL_MINUTES} mins`
      );
    } else if (text.startsWith("/channels")) {
      const allowed = this.config.ALLOWED_CHANNELS;
      if (allowed.length > 0) {
        const list = allowed.map((c, i) => `${i + 1}. \`${c}\``).join("\n");
        await this.sendMessage(chatId, `📋 *Explicitly Monitored Channels:*\n\n${list}`);
      } else {
        await this.sendMessage(chatId, "📋 Currently scanning *all channels* your user account has joined.");
      }
    }
  }

  private async sendMessage(chatId: string | number, text: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      });
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, "Failed to send bot message");
    }
  }
}
