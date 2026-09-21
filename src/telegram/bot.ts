import { Config } from "../config/env.js";
import { ChannelRepository } from "../database/repositories/channel.repo.js";
import { ConfigRepository } from "../database/repositories/config.repo.js";
import { SettingsRepository } from "../database/repositories/settings.repo.js";
import { logger } from "../logger.js";
import { ScanOrchestrator } from "../scheduler/orchestrator.js";

type UserState =
  | "idle"
  | "waiting_for_add_channel"
  | "waiting_for_add_proxy_channel"
  | "waiting_for_custom_interval"
  | "waiting_for_custom_text"
  | "waiting_for_custom_proxy_text"
  | "waiting_for_custom_remarks"
  | "waiting_for_custom_max_posts";

function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

  // --- Persistent Bottom Reply Keyboard ---

  private getPersistentReplyKeyboard(): any {
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();
    return {
      keyboard: [
        [
          { text: "🚀 اسکن کانفیگ" },
          { text: "⚡ اسکن پروکسی" },
        ],
        [
          { text: isConfigActive ? "⏹ توقف کانفیگ" : "▶️ شروع کانفیگ" },
          { text: isProxyActive ? "⏹ توقف پروکسی" : "▶️ شروع پروکسی" },
        ],
        [
          { text: "⚙️ تنظیمات" },
          { text: "📊 وضعیت سرور" },
        ],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  // --- Message Dispatcher ---

  private async handleMessage(msg: any): Promise<void> {
    const rawText = msg.text.trim();
    const text = rawText.toLowerCase();
    const chatId = msg.chat.id;
    const fromId = msg.from?.id?.toString() || "";

    if (!this.isAuthorized(fromId)) {
      await this.sendMessage(chatId, "⛔ You are not authorized to control this bot.");
      return;
    }

    if (rawText === "/cancel" || text === "cancel" || text === "انصراف") {
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, "❌ عملیات لغو شد. (Action cancelled)");
      await this.sendMainMenu(chatId);
      return;
    }

    const state = this.userStates.get(fromId) || "idle";

    // Handle conversational inputs
    if (state === "waiting_for_add_channel") {
      const channels = rawText.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
      let addedCount = 0;
      for (const ch of channels) {
        if (this.settingsRepo.addAllowedChannel(ch)) {
          addedCount++;
        }
      }
      this.userStates.set(fromId, "idle");
      await this.sendMessage(
        chatId,
        `✅ تعداد <b>${addedCount}</b> کانال به لیست کانال‌های کانفیگ اضافه شد!\n\n📋 <b>لیست کانال‌های فعلی:</b>\n${this.renderChannelList()}`
      );
      await this.sendChannelsMenu(chatId);
      return;
    }

    if (state === "waiting_for_add_proxy_channel") {
      const channels = rawText.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
      let addedCount = 0;
      for (const ch of channels) {
        if (this.settingsRepo.addAllowedProxyChannel(ch)) {
          addedCount++;
        }
      }
      this.userStates.set(fromId, "idle");
      await this.sendMessage(
        chatId,
        `✅ تعداد <b>${addedCount}</b> کانال به لیست کانال‌های پروکسی اضافه شد!\n\n🌐 <b>لیست کانال‌های پروکسی:</b>\n${this.renderProxyChannelList()}`
      );
      await this.sendProxyChannelsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_interval") {
      const num = parseInt(rawText, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر به دقیقه وارد کنید (مثلاً <code>20</code>):");
        return;
      }
      this.settingsRepo.setScanIntervalMinutes(num);
      this.orchestrator.rescheduleTimer(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `⏱️ زمان اسکن با موفقیت به <b>${num} دقیقه</b> تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_text") {
      this.settingsRepo.setCustomConfigPostText(rawText);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `✍️ متن سفارشی پست‌های کانفیگ ذخیره شد:\n\n<i>${escapeHtml(rawText)}</i>`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_proxy_text") {
      this.settingsRepo.setCustomProxyPostText(rawText);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `📝 متن سفارشی پست‌های پروکسی ذخیره شد:\n\n<i>${escapeHtml(rawText)}</i>`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_remarks") {
      this.settingsRepo.setCustomRemarks(rawText);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🏷️ نام رمارک کانال به <code>${escapeHtml(rawText)}</code> تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_max_posts") {
      const num = parseInt(rawText, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر وارد کنید (مثلاً <code>8</code>):");
        return;
      }
      this.settingsRepo.setMaxPostsPerCycle(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🔢 حداکثر تعداد پست در هر اسکن به <b>${num}</b> تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    // Match Reply Keyboard or Slash Commands
    if (text.includes("تنظیمات") || text.includes("settings") || text === "/settings") {
      this.userStates.set(fromId, "idle");
      await this.sendSettingsMenu(chatId);
    } else if (text.includes("اسکن کانفیگ") || text === "/scan_config") {
      await this.triggerConfigScan(chatId);
    } else if (text.includes("اسکن پروکسی") || text === "/scan_proxy") {
      await this.triggerProxyScan(chatId);
    } else if (text.includes("شروع اسکن") || text.includes("اسکن فوری") || text === "/scan") {
      await this.triggerFullScan(chatId);
    } else if (
      (text.includes("کانفیگ") && (text.includes("توقف") || text.includes("شروع") || text.includes("فعال"))) ||
      text === "/toggle_config"
    ) {
      const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
      if (isConfigActive) {
        this.orchestrator.pauseConfigMonitoring();
        await this.sendMessage(chatId, "🔴 اسکن خودکار کانفیگ‌ها متوقف شد.", undefined, this.getPersistentReplyKeyboard());
      } else {
        this.orchestrator.resumeConfigMonitoring();
        await this.sendMessage(chatId, "🟢 اسکن خودکار کانفیگ‌ها فعال شد.", undefined, this.getPersistentReplyKeyboard());
      }
      await this.sendMainMenu(chatId);
    } else if (
      (text.includes("پروکسی") && (text.includes("توقف") || text.includes("شروع") || text.includes("فعال"))) ||
      text === "/toggle_proxy"
    ) {
      const isProxyActive = this.settingsRepo.isProxyMonitoringActive();
      if (isProxyActive) {
        this.orchestrator.pauseProxyMonitoring();
        await this.sendMessage(chatId, "🔴 اسکن خودکار پروکسی‌ها متوقف شد.", undefined, this.getPersistentReplyKeyboard());
      } else {
        this.orchestrator.resumeProxyMonitoring();
        await this.sendMessage(chatId, "🟢 اسکن خودکار پروکسی‌ها فعال شد.", undefined, this.getPersistentReplyKeyboard());
      }
      await this.sendMainMenu(chatId);
    } else if (text.includes("توقف") || text.includes("فعال") || text.includes("toggle") || text === "/toggle") {
      const isActive = this.settingsRepo.isMonitoringActive();
      if (isActive) {
        this.orchestrator.pauseMonitoring();
        await this.sendMessage(chatId, "🔴 تمام اسکن‌های خودکار متوقف شدند.", undefined, this.getPersistentReplyKeyboard());
      } else {
        this.orchestrator.resumeMonitoring();
        await this.sendMessage(chatId, "🟢 تمام اسکن‌های خودکار فعال شدند.", undefined, this.getPersistentReplyKeyboard());
      }
      await this.sendMainMenu(chatId);
    } else if (text.includes("وضعیت") || text.includes("status") || text === "/status") {
      await this.sendStatus(chatId);
    } else if (text.includes("راهنما") || text.includes("help") || text === "/help") {
      await this.sendHelp(chatId);
    } else {
      this.userStates.set(fromId, "idle");
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
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuInlineKeyboard());
    } else if (data === "menu_settings") {
      this.userStates.set(fromId, "idle");
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "toggle_config_monitoring") {
      const current = this.settingsRepo.isConfigMonitoringActive();
      if (current) {
        this.orchestrator.pauseConfigMonitoring();
      } else {
        this.orchestrator.resumeConfigMonitoring();
      }
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuInlineKeyboard());
      await this.sendMessage(
        chatId,
        current ? "🔴 اسکن خودکار کانفیگ: متوقف شد" : "🟢 اسکن خودکار کانفیگ: فعال شد",
        undefined,
        this.getPersistentReplyKeyboard()
      );
    } else if (data === "toggle_proxy_monitoring") {
      const current = this.settingsRepo.isProxyMonitoringActive();
      if (current) {
        this.orchestrator.pauseProxyMonitoring();
      } else {
        this.orchestrator.resumeProxyMonitoring();
      }
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuInlineKeyboard());
      await this.sendMessage(
        chatId,
        current ? "🔴 اسکن خودکار پروکسی: متوقف شد" : "🟢 اسکن خودکار پروکسی: فعال شد",
        undefined,
        this.getPersistentReplyKeyboard()
      );
    } else if (data === "trigger_scan_config") {
      await this.triggerConfigScan(chatId);
    } else if (data === "trigger_scan_proxy") {
      await this.triggerProxyScan(chatId);
    } else if (data === "trigger_scan") {
      await this.triggerFullScan(chatId);
    } else if (data === "toggle_ping") {
      const current = this.settingsRepo.isIncludePingInPost();
      this.settingsRepo.setIncludePingInPost(!current);
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "toggle_check_ping_config") {
      const current = this.settingsRepo.isCheckPingBeforePostConfig();
      this.settingsRepo.setCheckPingBeforePostConfig(!current);
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "toggle_check_ping_proxy") {
      const current = this.settingsRepo.isCheckPingBeforePostProxy();
      this.settingsRepo.setCheckPingBeforePostProxy(!current);
      await this.editMessage(chatId, messageId, this.getSettingsMenuText(), this.getSettingsMenuKeyboard());
    } else if (data === "menu_channels") {
      await this.editMessage(chatId, messageId, this.getChannelsMenuText(), this.getChannelsMenuKeyboard());
    } else if (data === "add_channel") {
      this.userStates.set(fromId, "waiting_for_add_channel");
      await this.sendMessage(
        chatId,
        "➕ <b>افزودن کانال جدید برای اسکن کانفیگ</b>\n\n" +
          "آیدی یا یوزرنیم کانال مورد نظر را ارسال کنید (مثلاً <code>@config_channel</code> یا چندین کانال با کاما):\n\n" +
          "<i>(برای لغو عبارت /cancel را ارسال کنید)</i>"
      );
    } else if (data === "menu_remove_channel") {
      await this.editMessage(
        chatId,
        messageId,
        "➖ <b>روی کانال مورد نظر کلیک کنید تا حذف شود:</b>",
        this.getRemoveChannelsKeyboard()
      );
    } else if (data.startsWith("del_chan:")) {
      const targetChan = data.replace("del_chan:", "");
      this.settingsRepo.removeAllowedChannel(targetChan);
      await this.editMessage(
        chatId,
        messageId,
        `✅ کانال کانفیگ <code>${escapeHtml(targetChan)}</code> با موفقیت حذف شد!\n\n` + this.getChannelsMenuText(),
        this.getChannelsMenuKeyboard()
      );
    } else if (data === "menu_proxy_channels") {
      await this.editMessage(chatId, messageId, this.getProxyChannelsMenuText(), this.getProxyChannelsMenuKeyboard());
    } else if (data === "add_proxy_channel") {
      this.userStates.set(fromId, "waiting_for_add_proxy_channel");
      await this.sendMessage(
        chatId,
        "➕ <b>افزودن کانال جدید برای اسکن پروکسی تلگرام</b>\n\n" +
          "آیدی یا یوزرنیم کانال مورد نظر را ارسال کنید (مثلاً <code>@mtproxy_channel</code> یا چندین کانال با کاما):\n\n" +
          "<i>(برای لغو عبارت /cancel را ارسال کنید)</i>"
      );
    } else if (data === "menu_remove_proxy_channel") {
      await this.editMessage(
        chatId,
        messageId,
        "➖ <b>روی کانال پروکسی مورد نظر کلیک کنید تا حذف شود:</b>",
        this.getRemoveProxyChannelsKeyboard()
      );
    } else if (data.startsWith("del_pchan:")) {
      const targetChan = data.replace("del_pchan:", "");
      this.settingsRepo.removeAllowedProxyChannel(targetChan);
      await this.editMessage(
        chatId,
        messageId,
        `✅ کانال پروکسی <code>${escapeHtml(targetChan)}</code> با موفقیت حذف شد!\n\n` + this.getProxyChannelsMenuText(),
        this.getProxyChannelsMenuKeyboard()
      );
    } else if (data === "menu_interval") {
      await this.editMessage(
        chatId,
        messageId,
        `⏱️ <b>تغییر زمان‌بندی اسکن و ارسال</b>\n\nزمان فعلی: <b>هر ${this.settingsRepo.getScanIntervalMinutes()} دقیقه</b>\n\nیک زمان را انتخاب کنید یا مقدار دلخواه بزنید:`,
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
      await this.sendMessage(chatId, "⏱️ زمان اسکن را به دقیقه ارسال کنید (مثلاً <code>20</code> یا <code>45</code>):\n\n<i>(برای لغو /cancel بزنید)</i>");
    } else if (data === "menu_footer_text") {
      const current = this.settingsRepo.getCustomConfigPostText();
      const textMsg =
        `✍️ <b>متن دلخواه انتهای پست‌های کانفیگ</b>\n\n` +
        (current ? `متن فعلی:\n<i>${escapeHtml(current)}</i>\n\n` : `<i>هیچ متن سفارشی برای کانفیگ تنظیم نشده است.</i>\n\n`) +
        `این متن با یک خط فاصله قبل از آیدی کانال (<code>${escapeHtml(this.settingsRepo.getCustomRemarks())}</code>) قرار می‌گیرد.`;
      await this.editMessage(chatId, messageId, textMsg, this.getFooterTextKeyboard());
    } else if (data === "set_footer_text") {
      this.userStates.set(fromId, "waiting_for_custom_text");
      await this.sendMessage(
        chatId,
        "✍️ متنی که می‌خواهید در انتهای پست‌های کانفیگ قرار بگیرد را ارسال کنید:\n\n<i>(برای لغو /cancel بزنید)</i>"
      );
    } else if (data === "clear_footer_text") {
      this.settingsRepo.setCustomConfigPostText("");
      await this.editMessage(
        chatId,
        messageId,
        "🗑️ متن سفارشی کانفیگ حذف شد!\n\n" + this.getSettingsMenuText(),
        this.getSettingsMenuKeyboard()
      );
    } else if (data === "menu_proxy_footer_text") {
      const current = this.settingsRepo.getCustomProxyPostText();
      const textMsg =
        `📝 <b>متن دلخواه پست‌های پروکسی</b>\n\n` +
        (current ? `متن فعلی:\n<i>${escapeHtml(current)}</i>\n\n` : `<i>هیچ متن سفارشی برای پروکسی تنظیم نشده است.</i>\n\n`) +
        `این متن در بالای لینک‌های پروکسی و قبل از آیدی کانال قرار می‌گیرد.`;
      await this.editMessage(chatId, messageId, textMsg, this.getProxyFooterTextKeyboard());
    } else if (data === "set_proxy_footer_text") {
      this.userStates.set(fromId, "waiting_for_custom_proxy_text");
      await this.sendMessage(
        chatId,
        "✍️ متنی که می‌خواهید در پست‌های پروکسی تلگرام قرار بگیرد را ارسال کنید:\n\n<i>(برای لغو /cancel بزنید)</i>"
      );
    } else if (data === "clear_proxy_footer_text") {
      this.settingsRepo.setCustomProxyPostText("");
      await this.editMessage(
        chatId,
        messageId,
        "🗑️ متن سفارشی پروکسی حذف شد!\n\n" + this.getSettingsMenuText(),
        this.getSettingsMenuKeyboard()
      );
    } else if (data === "menu_max_posts") {
      await this.editMessage(
        chatId,
        messageId,
        `🔢 <b>حداکثر تعداد پست در هر اسکن</b>\n\nتعداد فعلی: <b>${this.settingsRepo.getMaxPostsPerCycle()} پست</b>\n\nتعداد کانفیگ سالم برای ارسال در هر دور را انتخاب کنید:`,
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
      await this.sendMessage(chatId, "🔢 حداکثر تعداد پست برای ارسال در هر اسکن را ارسال کنید (مثلاً <code>8</code>):\n\n<i>(برای لغو /cancel بزنید)</i>");
    } else if (data === "menu_remarks") {
      this.userStates.set(fromId, "waiting_for_custom_remarks");
      await this.sendMessage(
        chatId,
        `🏷️ <b>تغییر نام رمارک کانفیگ‌ها</b>\n\nنام فعلی: <code>${escapeHtml(this.settingsRepo.getCustomRemarks())}</code>\n\nنام رمارک جدید را ارسال کنید (مثلاً <code>@connexy_private</code>):\n\n<i>(برای لغو /cancel بزنید)</i>`
      );
    } else if (data === "menu_status") {
      await this.sendStatus(chatId);
    }
  }

  // --- Views and Keyboards ---

  private getMainMenuText(): string {
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();
    const checkPingConfig = this.settingsRepo.isCheckPingBeforePostConfig();
    const checkPingProxy = this.settingsRepo.isCheckPingBeforePostProxy();
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const channels = this.settingsRepo.getAllowedChannels();
    const proxyChannels = this.settingsRepo.getAllowedProxyChannels();
    const pingStatus = this.settingsRepo.isIncludePingInPost() ? "🟢 روشن" : "🔴 خاموش";
    const customConfigText = this.settingsRepo.getCustomConfigPostText() ? "✅ تنظیم شده" : "ندارد";
    const customProxyText = this.settingsRepo.getCustomProxyPostText() ? "✅ تنظیم شده" : "ندارد";

    return (
      `🤖 <b>کنترل پنل ربات مانیتورینگ VPN و پروکسی</b>\n\n` +
      `⚡ <b>اسکن خودکار کانفیگ:</b> ${isConfigActive ? "🟢 <code>فعال</code>" : "🔴 <code>متوقف</code>"}\n` +
      `⚡ <b>اسکن خودکار پروکسی:</b> ${isProxyActive ? "🟢 <code>فعال</code>" : "🔴 <code>متوقف</code>"}\n` +
      `🔍 <b>تست پینگ کانفیگ:</b> ${checkPingConfig ? "🟢 <code>فعال</code>" : "🔴 <code>غیرفعال</code>"}\n` +
      `🔍 <b>تست پینگ پروکسی:</b> ${checkPingProxy ? "🟢 <code>فعال</code>" : "🔴 <code>غیرفعال</code>"}\n` +
      `⏱️ <b>فاصله زمانی اسکن:</b> هر <b>${interval} دقیقه</b>\n` +
      `📢 <b>کانال‌های کانفیگ:</b> <b>${channels.length > 0 ? `${channels.length} کانال` : "تمام کانال‌های عضو شده"}</b>\n` +
      `🌐 <b>کانال‌های پروکسی:</b> <b>${proxyChannels.length > 0 ? `${proxyChannels.length} کانال` : "تنظیم نشده"}</b>\n` +
      `🎯 <b>کانال مقصد:</b> <code>${escapeHtml(this.config.TARGET_CHANNEL_ID)}</code>\n` +
      `📡 <b>نمایش پینگ در کانفیگ:</b> ${pingStatus}\n` +
      `✍️ <b>متن دلخواه کانفیگ:</b> ${customConfigText}\n` +
      `📝 <b>متن دلخواه پروکسی:</b> ${customProxyText}\n` +
      `🏷️ <b>رمارک کانفیگ‌ها:</b> <code>${escapeHtml(this.settingsRepo.getCustomRemarks())}</code>`
    );
  }

  private getMainMenuInlineKeyboard(): any {
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();
    return {
      inline_keyboard: [
        [
          { text: "🚀 اسکن فوری کانفیگ", callback_data: "trigger_scan_config" },
          { text: "⚡ اسکن فوری پروکسی", callback_data: "trigger_scan_proxy" },
        ],
        [
          {
            text: isConfigActive ? "کانفیگ: 🟢 فعال (توقف)" : "کانفیگ: 🔴 متوقف (شروع)",
            callback_data: "toggle_config_monitoring",
          },
          {
            text: isProxyActive ? "پروکسی: 🟢 فعال (توقف)" : "پروکسی: 🔴 متوقف (شروع)",
            callback_data: "toggle_proxy_monitoring",
          },
        ],
        [
          { text: "📊 وضعیت سرور", callback_data: "menu_status" },
          { text: "⚙️ ورود به تنظیمات", callback_data: "menu_settings" },
        ],
      ],
    };
  }

  private getSettingsMenuText(): string {
    const ping = this.settingsRepo.isIncludePingInPost() ? "🟢 روشن (ON)" : "🔴 خاموش (OFF)";
    const checkPingConfig = this.settingsRepo.isCheckPingBeforePostConfig()
      ? "🟢 فعال (تست قبل ارسال)"
      : "🔴 غیرفعال (ارسال بدون تست)";
    const checkPingProxy = this.settingsRepo.isCheckPingBeforePostProxy()
      ? "🟢 فعال (تست قبل ارسال)"
      : "🔴 غیرفعال (ارسال بدون تست)";
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const channels = this.settingsRepo.getAllowedChannels();
    const proxyChannels = this.settingsRepo.getAllowedProxyChannels();
    const maxPosts = this.settingsRepo.getMaxPostsPerCycle();
    const remarks = this.settingsRepo.getCustomRemarks();
    const customConfigText = this.settingsRepo.getCustomConfigPostText();
    const customProxyText = this.settingsRepo.getCustomProxyPostText();
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();

    return (
      `⚙️ <b>تنظیمات ربات مانیتورینگ</b>\n\n` +
      `⚡ <b>اسکن خودکار کانفیگ:</b> ${isConfigActive ? "🟢 فعال" : "🔴 متوقف"}\n` +
      `⚡ <b>اسکن خودکار پروکسی:</b> ${isProxyActive ? "🟢 فعال" : "🔴 متوقف"}\n` +
      `🔍 <b>تست پینگ کانفیگ قبل ارسال:</b> ${checkPingConfig}\n` +
      `🔍 <b>تست پینگ پروکسی قبل ارسال:</b> ${checkPingProxy}\n` +
      `⚡ <b>نمایش پینگ در کانفیگ:</b> ${ping}\n` +
      `⏱️ <b>زمان اسکن:</b> هر ${interval} دقیقه\n` +
      `📢 <b>کانال‌های کانفیگ (${channels.length}):</b> ${escapeHtml(channels.join(", ") || "همه کانال‌ها")}\n` +
      `🌐 <b>کانال‌های پروکسی (${proxyChannels.length}):</b> ${escapeHtml(proxyChannels.join(", ") || "تنظیم نشده")}\n` +
      `🔢 <b>حداکثر پست کانفیگ در هر اسکن:</b> ${maxPosts}\n` +
      `🏷️ <b>نام رمارک کانفیگ:</b> <code>${escapeHtml(remarks)}</code>\n` +
      `✍️ <b>متن دلخواه پست کانفیگ:</b> ${customConfigText ? `\n<i>${escapeHtml(customConfigText)}</i>` : "<i>تنظیم نشده</i>"}\n` +
      `📝 <b>متن دلخواه پست پروکسی:</b> ${customProxyText ? `\n<i>${escapeHtml(customProxyText)}</i>` : "<i>تنظیم نشده</i>"}\n\n` +
      `گزینه مورد نظر برای تغییر را انتخاب کنید:`
    );
  }

  private getSettingsMenuKeyboard(): any {
    const pingActive = this.settingsRepo.isIncludePingInPost();
    const checkPingConfig = this.settingsRepo.isCheckPingBeforePostConfig();
    const checkPingProxy = this.settingsRepo.isCheckPingBeforePostProxy();
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const maxPosts = this.settingsRepo.getMaxPostsPerCycle();
    const channelsCount = this.settingsRepo.getAllowedChannels().length;
    const proxyChannelsCount = this.settingsRepo.getAllowedProxyChannels().length;
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();

    return {
      inline_keyboard: [
        [
          {
            text: `اسکن خودکار کانفیگ: ${isConfigActive ? "🟢 روشن" : "🔴 خاموش"}`,
            callback_data: "toggle_config_monitoring",
          },
          {
            text: `اسکن خودکار پروکسی: ${isProxyActive ? "🟢 روشن" : "🔴 خاموش"}`,
            callback_data: "toggle_proxy_monitoring",
          },
        ],
        [
          {
            text: `تست پینگ کانفیگ: ${checkPingConfig ? "🟢 فعال" : "🔴 غیرفعال"}`,
            callback_data: "toggle_check_ping_config",
          },
          {
            text: `تست پینگ پروکسی: ${checkPingProxy ? "🟢 فعال" : "🔴 غیرفعال"}`,
            callback_data: "toggle_check_ping_proxy",
          },
        ],
        [
          {
            text: `⚡ نمایش پینگ در کانفیگ: ${pingActive ? "🟢 روشن" : "🔴 خاموش"}`,
            callback_data: "toggle_ping",
          },
        ],
        [
          { text: `📢 کانال‌های کانفیگ (${channelsCount})`, callback_data: "menu_channels" },
          { text: `🌐 کانال‌های پروکسی (${proxyChannelsCount})`, callback_data: "menu_proxy_channels" },
        ],
        [
          { text: "✍️ متن پست کانفیگ", callback_data: "menu_footer_text" },
          { text: "📝 متن پست پروکسی", callback_data: "menu_proxy_footer_text" },
        ],
        [
          { text: `⏱️ زمان اسکن (${interval} دقیقه)`, callback_data: "menu_interval" },
          { text: `🔢 سقف پست کانفیگ (${maxPosts})`, callback_data: "menu_max_posts" },
        ],
        [{ text: "🏷️ ویرایش رمارک کانفیگ", callback_data: "menu_remarks" }],
        [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "menu_main" }],
      ],
    };
  }

  private getChannelsMenuText(): string {
    const channels = this.settingsRepo.getAllowedChannels();
    return (
      `📢 <b>کانال‌های تحت بررسی برای استخراج کانفیگ VPN</b>\n\n` +
      (channels.length > 0
        ? channels.map((c, i) => `${i + 1}. <code>${escapeHtml(c)}</code>`).join("\n")
        : `<i>هیچ کانال خاصی تنظیم نشده (تمام کانال‌های عضو شده اسکن می‌شوند)</i>`) +
      `\n\nبرای افزودن یا حذف کانال از دکمه‌های زیر استفاده کنید:`
    );
  }

  private getChannelsMenuKeyboard(): any {
    const channels = this.settingsRepo.getAllowedChannels();
    const keyboard = [
      [{ text: "➕ افزودن کانال کانفیگ", callback_data: "add_channel" }],
    ];

    if (channels.length > 0) {
      keyboard.push([{ text: "➖ حذف کانال کانفیگ", callback_data: "menu_remove_channel" }]);
    }

    keyboard.push([{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }]);
    return { inline_keyboard: keyboard };
  }

  private getRemoveChannelsKeyboard(): any {
    const channels = this.settingsRepo.getAllowedChannels();
    const rows = channels.map((c) => [
      { text: `🗑️ حذف ${c}`, callback_data: `del_chan:${c}` },
    ]);
    rows.push([{ text: "🔙 انصراف", callback_data: "menu_channels" }]);
    return { inline_keyboard: rows };
  }

  private getProxyChannelsMenuText(): string {
    const channels = this.settingsRepo.getAllowedProxyChannels();
    return (
      `🌐 <b>کانال‌های تحت بررسی برای استخراج پروکسی تلگرام (MTProto / Socks)</b>\n\n` +
      (channels.length > 0
        ? channels.map((c, i) => `${i + 1}. <code>${escapeHtml(c)}</code>`).join("\n")
        : `<i>هیچ کانال پروکسی تنظیم نشده است.</i>`) +
      `\n\nبرای افزودن یا حذف کانال پروکسی از دکمه‌های زیر استفاده کنید:`
    );
  }

  private getProxyChannelsMenuKeyboard(): any {
    const channels = this.settingsRepo.getAllowedProxyChannels();
    const keyboard = [
      [{ text: "➕ افزودن کانال پروکسی", callback_data: "add_proxy_channel" }],
    ];

    if (channels.length > 0) {
      keyboard.push([{ text: "➖ حذف کانال پروکسی", callback_data: "menu_remove_proxy_channel" }]);
    }

    keyboard.push([{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }]);
    return { inline_keyboard: keyboard };
  }

  private getRemoveProxyChannelsKeyboard(): any {
    const channels = this.settingsRepo.getAllowedProxyChannels();
    const rows = channels.map((c) => [
      { text: `🗑️ حذف ${c}`, callback_data: `del_pchan:${c}` },
    ]);
    rows.push([{ text: "🔙 انصراف", callback_data: "menu_proxy_channels" }]);
    return { inline_keyboard: rows };
  }

  private getIntervalKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: "5 دقیقه", callback_data: "set_int:5" },
          { text: "10 دقیقه", callback_data: "set_int:10" },
          { text: "15 دقیقه", callback_data: "set_int:15" },
        ],
        [
          { text: "30 دقیقه", callback_data: "set_int:30" },
          { text: "60 دقیقه", callback_data: "set_int:60" },
          { text: "120 دقیقه", callback_data: "set_int:120" },
        ],
        [{ text: "✏️ وارد کردن عدد دلخواه", callback_data: "custom_interval" }],
        [{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }],
      ],
    };
  }

  private getFooterTextKeyboard(): any {
    const hasText = !!this.settingsRepo.getCustomConfigPostText();
    const buttons = [{ text: "✏️ تنظیم متن جدید", callback_data: "set_footer_text" }];
    if (hasText) {
      buttons.push({ text: "🗑️ پاک کردن متن", callback_data: "clear_footer_text" });
    }
    return {
      inline_keyboard: [
        buttons,
        [{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }],
      ],
    };
  }

  private getProxyFooterTextKeyboard(): any {
    const hasText = !!this.settingsRepo.getCustomProxyPostText();
    const buttons = [{ text: "✏️ تنظیم متن جدید", callback_data: "set_proxy_footer_text" }];
    if (hasText) {
      buttons.push({ text: "🗑️ پاک کردن متن", callback_data: "clear_proxy_footer_text" });
    }
    return {
      inline_keyboard: [
        buttons,
        [{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }],
      ],
    };
  }

  private getMaxPostsKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: "1 عدد", callback_data: "set_max:1" },
          { text: "3 عدد", callback_data: "set_max:3" },
          { text: "5 عدد", callback_data: "set_max:5" },
          { text: "10 عدد", callback_data: "set_max:10" },
        ],
        [{ text: "✏️ وارد کردن عدد دلخواه", callback_data: "custom_max_posts" }],
        [{ text: "🔙 بازگشت به تنظیمات", callback_data: "menu_settings" }],
      ],
    };
  }

  private renderChannelList(): string {
    const channels = this.settingsRepo.getAllowedChannels();
    return channels.length > 0
      ? channels.map((c, i) => `${i + 1}. <code>${escapeHtml(c)}</code>`).join("\n")
      : "<i>همه کانال‌های عضو شده</i>";
  }

  private renderProxyChannelList(): string {
    const channels = this.settingsRepo.getAllowedProxyChannels();
    return channels.length > 0
      ? channels.map((c, i) => `${i + 1}. <code>${escapeHtml(c)}</code>`).join("\n")
      : "<i>هیچ کانال پروکسی تنظیم نشده</i>";
  }

  // --- Telegram API Helpers ---

  private async sendMainMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      this.getMainMenuText(),
      this.getMainMenuInlineKeyboard(),
      this.getPersistentReplyKeyboard()
    );
  }

  private async sendSettingsMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      this.getSettingsMenuText(),
      this.getSettingsMenuKeyboard(),
      this.getPersistentReplyKeyboard()
    );
  }

  private async sendChannelsMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      this.getChannelsMenuText(),
      this.getChannelsMenuKeyboard(),
      this.getPersistentReplyKeyboard()
    );
  }

  private async sendProxyChannelsMenu(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      this.getProxyChannelsMenuText(),
      this.getProxyChannelsMenuKeyboard(),
      this.getPersistentReplyKeyboard()
    );
  }

  private async triggerConfigScan(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, "🔍 در حال اسکن کانال‌های کانفیگ و تست اتصال...", undefined, this.getPersistentReplyKeyboard());
    this.orchestrator
      .triggerManualConfigScan()
      .then(() => {
        this.sendMessage(chatId, "✅ اسکن و ارسال کانفیگ‌های سالم با موفقیت انجام شد!", undefined, this.getPersistentReplyKeyboard());
      })
      .catch((err) => {
        this.sendMessage(chatId, `❌ خطا در اسکن کانفیگ: ${escapeHtml(err.message)}`, undefined, this.getPersistentReplyKeyboard());
      });
  }

  private async triggerProxyScan(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, "⚡ در حال اسکن کانال‌های پروکسی تلگرام و تست پینگ...", undefined, this.getPersistentReplyKeyboard());
    this.orchestrator
      .triggerManualProxyScan()
      .then(() => {
        this.sendMessage(chatId, "✅ اسکن و ارسال پروکسی‌های تلگرام با موفقیت انجام شد!", undefined, this.getPersistentReplyKeyboard());
      })
      .catch((err) => {
        this.sendMessage(chatId, `❌ خطا در اسکن پروکسی: ${escapeHtml(err.message)}`, undefined, this.getPersistentReplyKeyboard());
      });
  }

  private async triggerFullScan(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, "🔍 در حال اسکن کامل کانال‌های کانفیگ و پروکسی...", undefined, this.getPersistentReplyKeyboard());
    this.orchestrator
      .triggerManualScan()
      .then(() => {
        this.sendMessage(chatId, "✅ اسکن کامل با موفقیت به پایان رسید!", undefined, this.getPersistentReplyKeyboard());
      })
      .catch((err) => {
        this.sendMessage(chatId, `❌ خطا در اسکن کامل: ${escapeHtml(err.message)}`, undefined, this.getPersistentReplyKeyboard());
      });
  }

  private async sendStatus(chatId: string | number): Promise<void> {
    const allChannels = this.channelRepo.getAllChannels();
    const isCheckPingConfig = this.settingsRepo.isCheckPingBeforePostConfig();
    const isCheckPingProxy = this.settingsRepo.isCheckPingBeforePostProxy();
    const unpostedConfigs = this.configRepo
      .getUnpostedConfigs(100, isCheckPingConfig)
      .filter((c) => c.protocol !== "mtproto" && c.protocol !== "socks5");
    const unpostedProxies = this.configRepo
      .getUnpostedConfigs(100, isCheckPingProxy)
      .filter((c) => c.protocol === "mtproto" || c.protocol === "socks5");
    const isConfigActive = this.settingsRepo.isConfigMonitoringActive();
    const isProxyActive = this.settingsRepo.isProxyMonitoringActive();
    const interval = this.settingsRepo.getScanIntervalMinutes();

    await this.sendMessage(
      chatId,
      `📊 <b>وضعیت سرور و ربات</b>\n\n` +
        `⚡ <b>وضعیت اسکن کانفیگ:</b> ${isConfigActive ? "🟢 فعال و خودکار" : "🔴 متوقف شده"}\n` +
        `⚡ <b>وضعیت اسکن پروکسی:</b> ${isProxyActive ? "🟢 فعال و خودکار" : "🔴 متوقف شده"}\n` +
        `🔍 <b>تست پینگ قبل ارسال (کانفیگ):</b> ${isCheckPingConfig ? "🟢 فعال" : "🔴 غیرفعال"}\n` +
        `🔍 <b>تست پینگ قبل ارسال (پروکسی):</b> ${isCheckPingProxy ? "🟢 فعال" : "🔴 غیرفعال"}\n` +
        `📡 <b>تعداد کانال‌ها در دیتابیس:</b> ${allChannels.length}\n` +
        `🟢 <b>کانفیگ‌های آماده ارسال:</b> ${unpostedConfigs.length}\n` +
        `🎁 <b>پروکسی‌های آماده ارسال:</b> ${unpostedProxies.length}\n` +
        `🎯 <b>کانال ارسال:</b> <code>${escapeHtml(this.config.TARGET_CHANNEL_ID)}</code>\n` +
        `⏱️ <b>زمان‌بندی اسکن:</b> هر ${interval} دقیقه`,
      {
        inline_keyboard: [
          [
            { text: "🚀 اسکن کانفیگ", callback_data: "trigger_scan_config" },
            { text: "⚡ اسکن پروکسی", callback_data: "trigger_scan_proxy" },
          ],
          [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "menu_main" }],
        ],
      },
      this.getPersistentReplyKeyboard()
    );
  }

  private async sendHelp(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      `❓ <b>راهنمای استفاده از ربات مانیتورینگ VPN و پروکسی</b>\n\n` +
        `1️⃣ <b>🚀 اسکن کانفیگ:</b> اسکن فوری و ارسال کانفیگ‌های VPN سالم.\n` +
        `2️⃣ <b>⚡ اسکن پروکسی:</b> اسکن فوری و ارسال پروکسی‌های تلگرام (MTProto).\n` +
        `3️⃣ <b>⏹ توقف / فعال‌سازی مستقل:</b> کنترل زمان‌بندی خودکار به تفکیک برای کانفیگ و پروکسی.\n` +
        `4️⃣ <b>⚙️ تنظیمات:</b> مدیریت کانال‌ها، متن‌های اختصاصی، پینگ و زمان‌بندی.\n` +
        `5️⃣ <b>📊 وضعیت سرور:</b> آمار لحظه‌ای دیتابیس و وضعیت اسکنرها.\n\n` +
        `<i>برای رفتن به منوی تنظیمات از دکمه زیر استفاده کنید.</i>`,
      {
        inline_keyboard: [[{ text: "⚙️ ورود به تنظیمات", callback_data: "menu_settings" }]],
      },
      this.getPersistentReplyKeyboard()
    );
  }

  private isAuthorized(fromId: string): boolean {
    if (this.config.ADMIN_USER_IDS.length === 0) return true;
    return !!fromId && this.config.ADMIN_USER_IDS.includes(fromId);
  }

  private async sendMessage(
    chatId: string | number,
    text: string,
    inlineMarkup?: any,
    replyKeyboard?: any
  ): Promise<void> {
    try {
      const body: any = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      };

      if (inlineMarkup) {
        body.reply_markup = inlineMarkup;
      } else if (replyKeyboard) {
        body.reply_markup = replyKeyboard;
      } else {
        body.reply_markup = this.getPersistentReplyKeyboard();
      }

      const res = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as any;
      if (!data.ok) {
        logger.warn({ error: data.description, chatId }, "Telegram sendMessage failed with HTML, retrying plain text");
        body.parse_mode = undefined;
        body.text = text.replace(/<[^>]*>/g, "");
        await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
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
      const body: any = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      };

      const res = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as any;
      if (!data.ok) {
        logger.warn({ error: data.description, chatId, messageId }, "editMessageText failed with HTML, retrying plain text or new message");
        body.parse_mode = undefined;
        body.text = text.replace(/<[^>]*>/g, "");
        const retryRes = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const retryData = (await retryRes.json()) as any;
        if (!retryData.ok) {
          await this.sendMessage(chatId, text, replyMarkup, this.getPersistentReplyKeyboard());
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, "Error editing message, sending new message instead");
      await this.sendMessage(chatId, text, replyMarkup, this.getPersistentReplyKeyboard());
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
