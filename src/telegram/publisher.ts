import { TelegramClient } from "telegram";
import { Config } from "../config/env.js";
import { ConfigRepository, ConfigRecord } from "../database/repositories/config.repo.js";
import { SettingsRepository } from "../database/repositories/settings.repo.js";
import { logger } from "../logger.js";

export class TelegramPublisher {
  private client: TelegramClient;
  private configRepo: ConfigRepository;
  private settingsRepo?: SettingsRepository;
  private config: Config;

  constructor(
    client: TelegramClient,
    configRepo: ConfigRepository,
    config: Config,
    settingsRepo?: SettingsRepository
  ) {
    this.client = client;
    this.configRepo = configRepo;
    this.config = config;
    this.settingsRepo = settingsRepo;
  }

  async publishHealthyConfig(configRecord: ConfigRecord): Promise<boolean> {
    if (this.configRepo.isConfigPosted(configRecord.hash)) {
      return false;
    }

    const messageText = this.formatConfigMessage(configRecord);

    try {
      await this.client.sendMessage(this.config.TARGET_CHANNEL_ID, {
        message: messageText,
        parseMode: "md",
        linkPreview: false,
      });

      this.configRepo.markAsPosted(configRecord.hash);
      logger.info(
        {
          hash: configRecord.hash.slice(0, 8),
          protocol: configRecord.protocol,
          server: configRecord.server,
          latency: configRecord.latency_ms,
        },
        "Published healthy VPN config to channel!"
      );

      // Brief delay to avoid hitting Telegram broadcast rate limits
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } catch (err: any) {
      if (err.message && err.message.includes("FLOOD_WAIT_")) {
        const seconds = parseInt(err.message.replace(/.*FLOOD_WAIT_(\d+).*/, "$1"), 10) || 10;
        logger.warn({ waitSeconds: seconds }, "Telegram flood wait hit, pausing publisher...");
        await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
      } else {
        logger.error({ err: err.message, target: this.config.TARGET_CHANNEL_ID }, "Failed to publish config to channel");
      }
      return false;
    }
  }

  async publishBatch(records: ConfigRecord[]): Promise<number> {
    let publishedCount = 0;
    for (const record of records) {
      const success = await this.publishHealthyConfig(record);
      if (success) publishedCount++;
    }
    return publishedCount;
  }

  formatConfigMessage(record: ConfigRecord): string {
    const latency = record.latency_ms ?? 0;
    let speedBadge = "🟢 Fast";
    if (latency > 600) {
      speedBadge = "🔴 Slow";
    } else if (latency > 300) {
      speedBadge = "🟡 Normal";
    }

    const protocolName = record.protocol.toUpperCase();
    let details: Record<string, unknown> = {};
    if (record.parsed_details) {
      try {
        details = JSON.parse(record.parsed_details);
      } catch {
        // ignore
      }
    }

    const security = details.security && details.security !== "none" ? ` (${details.security})` : "";
    const transport = details.transport && details.transport !== "tcp" ? ` (${details.transport})` : "";

    const rawTag = this.settingsRepo
      ? this.settingsRepo.getCustomRemarks()
      : this.config.CUSTOM_CONFIG_REMARKS;
    const channelTag = rawTag.startsWith("@") ? rawTag : `@${rawTag}`;

    const includePing = this.settingsRepo
      ? this.settingsRepo.isIncludePingInPost()
      : this.config.INCLUDE_PING_IN_POST;

    const customPostText = this.settingsRepo
      ? this.settingsRepo.getCustomPostText()
      : "";

    const lines = [
      "```",
      record.raw_config,
      "```",
      `📡 پروتکل: \`${protocolName}${security || transport}\``,
    ];

    if (includePing) {
      lines.push(`⚡️ پینگ: \`${latency} ms\` (${speedBadge})`);
    }

    if (customPostText) {
      lines.push("");
      lines.push(customPostText);
    }

    lines.push("");
    lines.push(channelTag);

    return lines.join("\n");
  }
}
