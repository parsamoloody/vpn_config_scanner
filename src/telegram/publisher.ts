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

  async publishProxiesBatch(records: ConfigRecord[]): Promise<number> {
    const unposted = records.filter((r) => !this.configRepo.isConfigPosted(r.hash));
    if (unposted.length === 0) return 0;

    // Send in batches of up to 10 proxies per post
    const batchSize = 10;
    let publishedCount = 0;

    for (let i = 0; i < unposted.length; i += batchSize) {
      const chunk = unposted.slice(i, i + batchSize);
      const messageText = this.formatProxiesMessage(chunk);

      try {
        await this.client.sendMessage(this.config.TARGET_CHANNEL_ID, {
          message: messageText,
          parseMode: "html",
          linkPreview: false,
        });

        for (const record of chunk) {
          this.configRepo.markAsPosted(record.hash);
          publishedCount++;
        }

        logger.info(
          { count: chunk.length, target: this.config.TARGET_CHANNEL_ID },
          "Published bundled MTProto/Socks proxies to channel!"
        );

        await new Promise((r) => setTimeout(r, 1200));
      } catch (err: any) {
        if (err.message && err.message.includes("FLOOD_WAIT_")) {
          const seconds = parseInt(err.message.replace(/.*FLOOD_WAIT_(\d+).*/, "$1"), 10) || 10;
          logger.warn({ waitSeconds: seconds }, "Telegram flood wait hit, pausing publisher...");
          await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
        } else if (err.message && (err.message.includes("entities") || err.message.includes("entity") || err.message.includes("parse"))) {
          logger.warn({ err: err.message }, "HTML publish failed for proxies, falling back to plain links");
          try {
            const plainLinks = chunk.map((c, idx) => `پروکسی ${idx + 1}: ${c.raw_config}`).join("\n");
            await this.client.sendMessage(this.config.TARGET_CHANNEL_ID, {
              message: `🎁 پروکسی‌های پرسرعت تلگرام\n\n${plainLinks}\n\n${this.config.CUSTOM_CONFIG_REMARKS}`,
              linkPreview: false,
            });
            for (const record of chunk) {
              this.configRepo.markAsPosted(record.hash);
              publishedCount++;
            }
          } catch (retryErr: any) {
            logger.error({ err: retryErr.message }, "Fallback plain text publish also failed");
          }
        } else {
          logger.error({ err: err.message, target: this.config.TARGET_CHANNEL_ID }, "Failed to publish proxies batch");
        }
      }
    }

    return publishedCount;
  }

  formatProxiesMessage(records: ConfigRecord[]): string {
    const rawTag = this.settingsRepo
      ? this.settingsRepo.getCustomRemarks()
      : this.config.CUSTOM_CONFIG_REMARKS;
    const channelTag = rawTag.startsWith("@") ? rawTag : `@${rawTag}`;

    const customProxyText = this.settingsRepo
      ? this.settingsRepo.getCustomProxyPostText()
      : this.config.CUSTOM_PROXY_POST_TEXT || "";

    const escapeHtml = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const proxyLinks = records.map((record) => {
      const url = record.raw_config;
      return `<a href="${escapeHtml(url)}">پروکسی</a>`;
    });

    const lines: string[] = ["🎁 <b>پروکسی‌های پرسرعت تلگرام</b>"];

    if (customProxyText) {
      lines.push("");
      lines.push(escapeHtml(customProxyText));
    }

    lines.push("");
    lines.push(`🔗 ${proxyLinks.join(" | ")}`);
    lines.push("");
    lines.push(escapeHtml(channelTag));

    return lines.join("\n");
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
      ? this.settingsRepo.getCustomConfigPostText()
      : "";

    const lines = [
      "```",
      record.raw_config,
      "```",
      `📡 پروتکل: \`${protocolName}${security || transport}\``,
    ];

    if (includePing && record.latency_ms !== null && record.latency_ms > 0) {
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
