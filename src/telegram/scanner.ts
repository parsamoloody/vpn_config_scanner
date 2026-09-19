import { TelegramClient } from "telegram";
import { Config } from "../config/env.js";
import { ChannelRepository } from "../database/repositories/channel.repo.js";
import { extractRawConfigsFromText } from "../extractor/regex.js";
import { parseVpnConfig } from "../extractor/parser.js";
import { ParsedVpnConfig } from "../extractor/types.js";
import { logger } from "../logger.js";

export interface ScannedConfigItem {
  parsed: ParsedVpnConfig;
  sourceChannelId: string;
  sourceChannelTitle: string;
  sourceMessageId: number;
}

export class TelegramScanner {
  private client: TelegramClient;
  private channelRepo: ChannelRepository;
  private config: Config;

  constructor(client: TelegramClient, channelRepo: ChannelRepository, config: Config) {
    this.client = client;
    this.channelRepo = channelRepo;
    this.config = config;
  }

  async scanAllChannels(): Promise<{
    channelsScanned: number;
    messagesScanned: number;
    configsFound: ScannedConfigItem[];
  }> {
    let channelsScanned = 0;
    let messagesScanned = 0;
    const configsFound: ScannedConfigItem[] = [];

    const targetChannel = this.cleanIdentifier(this.config.TARGET_CHANNEL_ID).toLowerCase();
    const allowed = this.config.ALLOWED_CHANNELS.map((c) => this.cleanIdentifier(c));
    const excluded = this.config.EXCLUDED_CHANNELS.map((c) => this.cleanIdentifier(c).toLowerCase());

    // If specific channels are provided in ALLOWED_CHANNELS, scan only those directly
    if (allowed.length > 0) {
      logger.info({ allowedChannels: allowed }, "Scanning specific allowed channels...");

      for (const channelIdentifier of allowed) {
        if (excluded.includes(channelIdentifier.toLowerCase())) {
          logger.debug({ channel: channelIdentifier }, "Skipping excluded channel");
          continue;
        }

        if (channelIdentifier.toLowerCase() === targetChannel) {
          logger.debug({ channel: channelIdentifier }, "Skipping target channel from scan");
          continue;
        }

        try {
          const entity = await this.client.getEntity(channelIdentifier);
          if (!entity) continue;

          const res = await this.scanSingleChannelEntity(entity);
          channelsScanned++;
          messagesScanned += res.messagesScanned;
          configsFound.push(...res.configs);
        } catch (err: any) {
          logger.warn(
            { channel: channelIdentifier, err: err.message },
            "Failed to fetch or scan channel. Ensure the bot account has joined this channel."
          );
        }
      }

      return {
        channelsScanned,
        messagesScanned,
        configsFound,
      };
    }

    // Otherwise, scan all joined channels
    logger.info("No specific channels specified in ALLOWED_CHANNELS. Fetching all joined channels from Telegram...");
    const dialogs = await this.client.getDialogs({});

    for (const dialog of dialogs) {
      if (!dialog.isChannel) continue;

      const entity = dialog.entity as any;
      if (!entity) continue;

      const channelId = dialog.id ? dialog.id.toString() : entity.id?.toString();
      const username = entity.username || null;

      const idLower = channelId ? channelId.toLowerCase() : "";
      const usernameLower = username ? username.toLowerCase() : "";

      if (idLower === targetChannel || usernameLower === targetChannel) {
        continue;
      }

      if (excluded.includes(idLower) || (usernameLower && excluded.includes(usernameLower))) {
        continue;
      }

      try {
        const res = await this.scanSingleChannelEntity(entity, dialog.inputEntity);
        channelsScanned++;
        messagesScanned += res.messagesScanned;
        configsFound.push(...res.configs);
      } catch (err: any) {
        logger.warn({ channelId, title: entity.title, err: err.message }, "Error scanning channel");
      }
    }

    return {
      channelsScanned,
      messagesScanned,
      configsFound,
    };
  }

  private async scanSingleChannelEntity(
    entity: any,
    inputEntity?: any
  ): Promise<{ messagesScanned: number; configs: ScannedConfigItem[] }> {
    const channelId = entity.id ? entity.id.toString() : "";
    const title = entity.title || "Untitled Channel";
    const username = entity.username || null;

    this.channelRepo.upsertChannel(channelId, title, username);
    const channelRecord = this.channelRepo.getChannel(channelId);
    const lastScannedId = channelRecord?.last_scanned_message_id || 0;

    let maxMessageIdInBatch = lastScannedId;
    let newConfigsInChannel = 0;
    const configs: ScannedConfigItem[] = [];

    const messages = await this.client.getMessages(inputEntity || entity, {
      limit: lastScannedId === 0 ? this.config.INITIAL_CHANNEL_SCAN_LIMIT : this.config.SUBSEQUENT_CHANNEL_SCAN_LIMIT,
      minId: lastScannedId > 0 ? lastScannedId : undefined,
    });

    for (const msg of messages) {
      if (!msg.id) continue;
      if (msg.id > maxMessageIdInBatch) {
        maxMessageIdInBatch = msg.id;
      }

      const text = msg.message || (msg as any).text || "";
      if (!text) continue;

      const rawConfigs = extractRawConfigsFromText(text);
      for (const raw of rawConfigs) {
        const parsed = parseVpnConfig(raw, this.config.CUSTOM_CONFIG_REMARKS);
        if (parsed) {
          configs.push({
            parsed,
            sourceChannelId: channelId,
            sourceChannelTitle: title,
            sourceMessageId: msg.id,
          });
          newConfigsInChannel++;
        }
      }
    }

    this.channelRepo.updateScanProgress(channelId, maxMessageIdInBatch, newConfigsInChannel);

    logger.debug(
      { title, username, messagesCount: messages.length, newConfigs: newConfigsInChannel },
      "Finished scanning channel"
    );

    return {
      messagesScanned: messages.length,
      configs,
    };
  }

  private cleanIdentifier(identifier: string): string {
    return identifier
      .trim()
      .replace(/^https?:\/\/t\.me\//i, "")
      .replace(/^t\.me\//i, "")
      .replace(/^@/, "");
  }
}
