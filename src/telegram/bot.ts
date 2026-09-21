import { Config } from "../config/env.js";
import { ChannelRepository } from "../database/repositories/channel.repo.js";
import { ConfigRepository } from "../database/repositories/config.repo.js";
import { SettingsRepository } from "../database/repositories/settings.repo.js";
import { logger } from "../logger.js";
import { ScanOrchestrator } from "../scheduler/orchestrator.js";

type UserState =
  | "idle"
  | "waiting_for_add_channel"
  | "waiting_for_custom_interval"
  | "waiting_for_custom_text"
  | "waiting_for_custom_remarks"
  | "waiting_for_custom_max_posts";

export class TelegramBotService {
  private config: Config;
  private channelRepo: ChannelRepository;
  private configRepo: ConfigRepository;
  private settingsRepo: SettingsRepository;
  private orchestrator: ScanOrchestrator;
  private isPolling = false;
  private lastUpdateId = 0;
  private userStates = new Map<string, UserState>();

  constructor(
    config: Config,
    channelRepo: ChannelRepository,
    configRepo: ConfigRepository,
    orchestrator: ScanOrchestrator,
    settingsRepo: SettingsRepository
  ) {
    this.config = config;
    this.channelRepo = channelRepo;
    this.configRepo = configRepo;
    this.orchestrator = orchestrator;
    this.settingsRepo = settingsRepo;
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
        "Telegram Bot Service initialized and listening for commands & button clicks!"
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

            if (update.callback_query) {
              await this.handleCallbackQuery(update.callback_query);
            } else if (update.message && update.message.text) {
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

  // --- Message Dispatcher ---

  private async handleMessage(msg: any): Promise<void> {
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const fromId = msg.from?.id?.toString() || "";

    if (!this.isAuthorized(fromId)) {
      await this.sendMessage(chatId, "⛔ You are not authorized to control this bot.");
      return;
    }

    if (text === "/cancel") {
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, "❌ Action cancelled.");
      await this.sendMainMenu(chatId);
      return;
    }

    const state = this.userStates.get(fromId) || "idle";

    // Handle conversational inputs
    if (state === "waiting_for_add_channel") {
      const channels = text.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
      let addedCount = 0;
      for (const ch of channels) {
        if (this.settingsRepo.addAllowedChannel(ch)) {
          addedCount++;
        }
      }
      this.userStates.set(fromId, "idle");
      await this.sendMessage(
        chatId,
        `✅ Added ${addedCount} channel(s) to scan list!\n\n📋 Current Channels:\n${this.renderChannelList()}`
      );
      await this.sendChannelsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_interval") {
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ Please enter a valid positive number of minutes (e.g. `20`):");
        return;
      }
      this.settingsRepo.setScanIntervalMinutes(num);
      this.orchestrator.rescheduleTimer(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `⏱️ Scan interval updated to **${num} minutes**!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_text") {
      this.settingsRepo.setCustomPostText(text);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `✍️ Custom footer text saved:\n\n_${text}_`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_remarks") {
      this.settingsRepo.setCustomRemarks(text);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🏷️ Config remarks name updated to \`${text}\`!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_max_posts") {
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ Please enter a valid number (e.g. `7`):");
        return;
      }
      this.settingsRepo.setMaxPostsPerCycle(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🔢 Max posts per cycle updated to **${num}**!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    // Default commands
    if (text.startsWith("/start") || text.startsWith("/menu") || text.startsWith("/help")) {
      this.userStates.set(fromId, "idle");
      await this.sendMainMenu(chatId);
    } else if (text.startsWith("/scan")) {
      await this.triggerScan(chatId);
    } else if (text.startsWith("/settings")) {
      await this.sendSettingsMenu(chatId);
    } else if (text.startsWith("/status")) {
      await this.sendStatus(chatId);
    } else {
      await this.sendMainMenu(chatId);
    }
  }

  // --- Callback Query Dispatcher ---

  private async handleCallbackQuery(cb: any): Promise<void> {
    const data = cb.data;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const fromId = cb.from?.id?.toString() || "";

    if (!this.isAuthorized(fromId)) {
      await this.answerCallback(cb.id, "Unauthorized", true);
      return;
    }

    await this.answerCallback(cb.id);

    if (data === "menu_main") {
      this.userStates.set(fromId, "idle");
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuKeyboard());
    } else if (data === "menu_settings") {
      this.userStates.set(fromId, "idle");
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "toggle_monitoring") {
      const isCurrentlyActive = this.settingsRepo.isMonitoringActive();
      if (isCurrentlyActive) {
        this.orchestrator.pauseMonitoring();
      } else {
        this.orchestrator.resumeMonitoring();
      }
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuKeyboard());
    } else if (data === "trigger_scan") {
      await this.sendMessage(chatId, "🔍 Starting VPN scan & connectivity check cycle now...");
      this.orchestrator
        .triggerManualScan()
        .then(() => {
          this.sendMessage(chatId, "✅ Scan and publishing cycle completed successfully!");
        })
        .catch((err) => {
          this.sendMessage(chatId, `❌ Error during scan cycle: ${err.message}`);
        });
    } else if (data === "toggle_ping") {
      const current = this.settingsRepo.isIncludePingInPost();
      this.settingsRepo.setIncludePingInPost(!current);
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "menu_channels") {
      await this.editMessage(chatId, messageId, this.getChannelsMenuText(), this.getChannelsMenuKeyboard());
    } else if (data === "add_channel") {
      this.userStates.set(fromId, "waiting_for_add_channel");
      await this.sendMessage(
        chatId,
        "➕ **Add Channels to Scan**\n\n" +
          "Send the channel username or ID (e.g. `@proxy_channel` or `proxy_channel` or comma-separated list):\n\n" +
          "_(Type /cancel to abort)_"
      );
    } else if (data === "menu_remove_channel") {
      await this.editMessage(
        chatId,
        messageId,
        "➖ **Select a channel to remove:**",
        this.getRemoveChannelsKeyboard()
      );
    } else if (data.startsWith("del_chan:")) {
      const targetChan = data.replace("del_chan:", "");
      this.settingsRepo.removeAllowedChannel(targetChan);
      await this.editMessage(
        chatId,
        messageId,
        `✅ Removed \`${targetChan}\`!\n\n` + this.getChannelsMenuText(),
        this.getChannelsMenuKeyboard()
      );
    } else if (data === "menu_interval") {
      await this.editMessage(
        chatId,
        messageId,
        `⏱️ **Change Scan & Post Interval**\n\nCurrent: **Every ${this.settingsRepo.getScanIntervalMinutes()} minutes**\n\nSelect a preset or enter custom:`,
        this.getIntervalKeyboard()
      );
    } else if (data.startsWith("set_int:")) {
      const minutes = parseInt(data.replace("set_int:", ""), 10);
      if (!isNaN(minutes)) {
        this.settingsRepo.setScanIntervalMinutes(minutes);
        this.orchestrator.rescheduleTimer(minutes);
      }
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "custom_interval") {
      this.userStates.set(fromId, "waiting_for_custom_interval");
      await this.sendMessage(chatId, "⏱️ Send the scan interval in minutes (e.g. `20` or `45`):\n\n_(Type /cancel to abort)_");
    } else if (data === "menu_footer_text") {
      const current = this.settingsRepo.getCustomPostText();
      const textMsg =
        `✍️ **Custom Post Footer Text**\n\n` +
        (current ? `Current Text:\n_${current}_\n\n` : `_No custom footer text set._\n\n`) +
        `This text is inserted at the bottom of channel posts before \`${this.settingsRepo.getCustomRemarks()}\`.`;
      await this.editMessage(chatId, messageId, textMsg, this.getFooterTextKeyboard());
    } else if (data === "set_footer_text") {
      this.userStates.set(fromId, "waiting_for_custom_text");
      await this.sendMessage(
        chatId,
        "✍️ Send the text to insert at the bottom of posts (before the channel tag):\n\n_(Type /cancel to abort)_"
      );
    } else if (data === "clear_footer_text") {
      this.settingsRepo.setCustomPostText("");
      await this.editMessage(
        chatId,
        messageId,
        "🗑️ Custom footer text cleared!\n\n" + this.getSettingsMenuText(),
        this.getSettingsMenuKeyboard()
      );
    } else if (data === "menu_max_posts") {
      await this.editMessage(
        chatId,
        messageId,
        `🔢 **Max Posts per Scan Cycle**\n\nCurrent: **${this.settingsRepo.getMaxPostsPerCycle()} posts**\n\nSelect max configs to publish per cycle:`,
        this.getMaxPostsKeyboard()
      );
    } else if (data.startsWith("set_max:")) {
      const count = parseInt(data.replace("set_max:", ""), 10);
      if (!isNaN(count)) {
        this.settingsRepo.setMaxPostsPerCycle(count);
      }
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "custom_max_posts") {
      this.userStates.set(fromId, "waiting_for_custom_max_posts");
      await this.sendMessage(chatId, "🔢 Send max number of configs to post per cycle (e.g. `8`):\n\n_(Type /cancel to abort)_");
    } else if (data === "menu_remarks") {
      this.userStates.set(fromId, "waiting_for_custom_remarks");
      await this.sendMessage(
        chatId,
        `🏷️ **Change Config Remarks Name**\n\nCurrent: \`${this.settingsRepo.getCustomRemarks()}\`\n\nSend the new remarks name (e.g. \`@connexy_private\`):\n\n_(Type /cancel to abort)_`
      );
    } else if (data === "menu_status") {
      await this.sendStatus(chatId);
    }
  }

  // --- Views and Keyboards ---

  private getMainMenuText(): string {
    const isActive = this.settingsRepo.isMonitoringActive();
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const channels = this.settingsRepo.getAllowedChannels();
    const pingStatus = this.settingsRepo.isIncludePingInPost() ? "🟢 ON" : "🔴 OFF";
    const customText = this.settingsRepo.getCustomPostText() ? "✅ Set" : "None";

    return (
      `🤖 **Telegram VPN Monitor Control Panel**\n\n` +
      `⚡ **Status:** ${isActive ? "🟢 `RUNNING`" : "🔴 `PAUSED`"}\n` +
      `⏱️ **Scan Schedule:** Every **${interval} minutes**\n` +
      `📢 **Monitored Channels:** **${channels.length > 0 ? channels.length : "All Joined"}**\n` +
      `🎯 **Target Channel:** \`${this.config.TARGET_CHANNEL_ID}\`\n` +
      `📡 **Ping in Posts:** ${pingStatus}\n` +
      `✍️ **Custom Footer:** ${customText}\n` +
      `🏷️ **Remarks:** \`${this.settingsRepo.getCustomRemarks()}\``
    );
  }

  private getMainMenuKeyboard(): any {
    const isActive = this.settingsRepo.isMonitoringActive();
    return {
      inline_keyboard: [
        [
          {
            text: isActive ? "⏹️ Pause Monitoring" : "▶️ Start Monitoring",
            callback_data: "toggle_monitoring",
          },
        ],
        [
          { text: "🚀 Run Immediate Scan", callback_data: "trigger_scan" },
          { text: "📊 Status", callback_data: "menu_status" },
        ],
        [{ text: "⚙️ Settings", callback_data: "menu_settings" }],
      ],
    };
  }

  private getSettingsMenuText(): string {
    const ping = this.settingsRepo.isIncludePingInPost() ? "🟢 Enabled" : "🔴 Disabled";
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const channels = this.settingsRepo.getAllowedChannels();
    const maxPosts = this.settingsRepo.getMaxPostsPerCycle();
    const remarks = this.settingsRepo.getCustomRemarks();
    const customText = this.settingsRepo.getCustomPostText();

    return (
      `⚙️ **VPN Monitor Settings**\n\n` +
      `⚡ **Ping Latency in Posts:** ${ping}\n` +
      `⏱️ **Scan Interval:** Every ${interval} mins\n` +
      `📢 **Channels (${channels.length}):** ${channels.join(", ") || "All Joined"}\n` +
      `🔢 **Max Posts per Cycle:** ${maxPosts}\n` +
      `🏷️ **Remarks Name:** \`${remarks}\`\n` +
      `✍️ **Footer Text:** ${customText ? `"${customText}"` : "_None_"}\n\n` +
      `Select an option below to modify:`
    );
  }

  private getSettingsMenuKeyboard(): any {
    const pingActive = this.settingsRepo.isIncludePingInPost();
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const maxPosts = this.settingsRepo.getMaxPostsPerCycle();

    return {
      inline_keyboard: [
        [
          {
            text: `⚡ Ping in Post: ${pingActive ? "🟢 ON" : "🔴 OFF"}`,
            callback_data: "toggle_ping",
          },
        ],
        [{ text: "📢 Manage Channels", callback_data: "menu_channels" }],
        [{ text: `⏱️ Scan Interval (${interval}m)`, callback_data: "menu_interval" }],
        [{ text: "✍️ Custom Footer Text", callback_data: "menu_footer_text" }],
        [{ text: `🔢 Max Posts (${maxPosts})`, callback_data: "menu_max_posts" }],
        [{ text: "🏷️ Edit Remarks Name", callback_data: "menu_remarks" }],
        [{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }],
      ],
    };
  }

  private getChannelsMenuText(): string {
    const channels = this.settingsRepo.getAllowedChannels();
    return (
      `📢 **Monitored Source Channels**\n\n` +
      (channels.length > 0
        ? channels.map((c, i) => `${i + 1}. \`${c}\``).join("\n")
        : `_No explicit channels set (scanning all joined channels)_`) +
      `\n\nUse buttons below to add or remove channels:`
    );
  }

  private getChannelsMenuKeyboard(): any {
    const channels = this.settingsRepo.getAllowedChannels();
    const keyboard = [
      [{ text: "➕ Add Channel", callback_data: "add_channel" }],
    ];

    if (channels.length > 0) {
      keyboard.push([{ text: "➖ Remove Channel", callback_data: "menu_remove_channel" }]);
    }

    keyboard.push([{ text: "🔙 Back to Settings", callback_data: "menu_settings" }]);
    return { inline_keyboard: keyboard };
  }

  private getRemoveChannelsKeyboard(): any {
    const channels = this.settingsRepo.getAllowedChannels();
    const rows = channels.map((c) => [
      { text: `🗑️ ${c}`, callback_data: `del_chan:${c}` },
    ]);
    rows.push([{ text: "🔙 Cancel", callback_data: "menu_channels" }]);
    return { inline_keyboard: rows };
  }

  private getIntervalKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: "5 min", callback_data: "set_int:5" },
          { text: "10 min", callback_data: "set_int:10" },
          { text: "15 min", callback_data: "set_int:15" },
        ],
        [
          { text: "30 min", callback_data: "set_int:30" },
          { text: "60 min", callback_data: "set_int:60" },
          { text: "120 min", callback_data: "set_int:120" },
        ],
        [{ text: "✏️ Custom Minutes", callback_data: "custom_interval" }],
        [{ text: "🔙 Back to Settings", callback_data: "menu_settings" }],
      ],
    };
  }

  private getFooterTextKeyboard(): any {
    const hasText = !!this.settingsRepo.getCustomPostText();
    const buttons = [{ text: "✏️ Set Text", callback_data: "set_footer_text" }];
    if (hasText) {
      buttons.push({ text: "🗑️ Clear Text", callback_data: "clear_footer_text" });
    }
    return {
      inline_keyboard: [
        buttons,
        [{ text: "🔙 Back to Settings", callback_data: "menu_settings" }],
      ],
    };
  }

  private getMaxPostsKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: "1", callback_data: "set_max:1" },
          { text: "3", callback_data: "set_max:3" },
          { text: "5", callback_data: "set_max:5" },
          { text: "10", callback_data: "set_max:10" },
        ],
        [{ text: "✏️ Custom Limit", callback_data: "custom_max_posts" }],
        [{ text: "🔙 Back to Settings", callback_data: "menu_settings" }],
      ],
    };
  }

  private renderChannelList(): string {
    const channels = this.settingsRepo.getAllowedChannels();
    return channels.length > 0
      ? channels.map((c, i) => `${i + 1}. \`${c}\``).join("\n")
      : "_All joined channels_";
  }

  // --- Telegram API Helpers ---

  private async sendMainMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, this.getMainMenuText(), this.getMainMenuKeyboard());
  }

  private async sendSettingsMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
  }

  private async sendChannelsMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, this.getChannelsMenuText(), this.getChannelsMenuKeyboard());
  }

  private async triggerScan(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, "🔍 Starting VPN scan & connectivity check cycle now...");
    this.orchestrator
      .triggerManualScan()
      .then(() => {
        this.sendMessage(chatId, "✅ Scan and publishing cycle completed successfully!");
      })
      .catch((err) => {
        this.sendMessage(chatId, `❌ Error during scan cycle: ${err.message}`);
      });
  }

  private async sendStatus(chatId: string | number): Promise<void> {
    const allChannels = this.channelRepo.getAllChannels();
    const unposted = this.configRepo.getUnpostedHealthyConfigs(100);
    const isActive = this.settingsRepo.isMonitoringActive();
    const interval = this.settingsRepo.getScanIntervalMinutes();

    await this.sendMessage(
      chatId,
      `📊 **VPN Monitor Status**\n\n` +
        `⚡ **Daemon Status:** ${isActive ? "🟢 ACTIVE" : "🔴 PAUSED"}\n` +
        `📡 **Channels in DB:** ${allChannels.length}\n` +
        `🟢 **Unposted Healthy Configs:** ${unposted.length}\n` +
        `🎯 **Target Channel:** \`${this.config.TARGET_CHANNEL_ID}\`\n` +
        `⏱️ **Scan Interval:** ${interval} mins`,
      {
        inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu_main" }]],
      }
    );
  }

  private isAuthorized(fromId: string): boolean {
    if (this.config.ADMIN_USER_IDS.length === 0) return true;
    return !!fromId && this.config.ADMIN_USER_IDS.includes(fromId);
  }

  private async sendMessage(chatId: string | number, text: string, replyMarkup?: any): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        }),
      });
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, "Failed to send bot message");
    }
  }

  private async editMessage(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: any
  ): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        }),
      });
    } catch (err: any) {
      logger.debug({ err: err.message }, "Error editing message, sending new message instead");
      await this.sendMessage(chatId, text, replyMarkup);
    }
  }

  private async answerCallback(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert,
        }),
      });
    } catch {
      // ignore
    }
  }
}
