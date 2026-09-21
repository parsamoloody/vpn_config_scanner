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

  // --- Persistent Bottom Reply Keyboard ---

  private getPersistentReplyKeyboard(): any {
    const isActive = this.settingsRepo.isMonitoringActive();
    return {
      keyboard: [
        [
          { text: "🚀 شروع اسکن فوری (Scan Now)" },
          { text: isActive ? "⏹ توقف اسکن خودکار (Pause)" : "▶️ فعال‌سازی اسکن خودکار (Start)" },
        ],
        [
          { text: "⚙️ تنظیمات (Settings)" },
          { text: "📊 وضعیت سرور (Status)" },
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
        `✅ تعداد ${addedCount} کانال به لیست اضافه شد!\n\n📋 **لیست کانال‌های فعلی:**\n${this.renderChannelList()}`
      );
      await this.sendChannelsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_interval") {
      const num = parseInt(rawText, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر به دقیقه وارد کنید (مثلاً `20`):");
        return;
      }
      this.settingsRepo.setScanIntervalMinutes(num);
      this.orchestrator.rescheduleTimer(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `⏱️ زمان اسکن با موفقیت به **${num} دقیقه** تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_text") {
      this.settingsRepo.setCustomPostText(rawText);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `✍️ متن سفارشی انتهای پست ذخیره شد:\n\n_${rawText}_`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_remarks") {
      this.settingsRepo.setCustomRemarks(rawText);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🏷️ نام رمارک کانال به \`${rawText}\` تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    if (state === "waiting_for_custom_max_posts") {
      const num = parseInt(rawText, 10);
      if (isNaN(num) || num < 1) {
        await this.sendMessage(chatId, "⚠️ لطفاً یک عدد معتبر وارد کنید (مثلاً `8`):");
        return;
      }
      this.settingsRepo.setMaxPostsPerCycle(num);
      this.userStates.set(fromId, "idle");
      await this.sendMessage(chatId, `🔢 حداکثر تعداد پست در هر اسکن به **${num}** تغییر یافت!`);
      await this.sendSettingsMenu(chatId);
      return;
    }

    // Match Reply Keyboard or Slash Commands
    if (text.includes("تنظیمات") || text.includes("settings") || text === "/settings") {
      this.userStates.set(fromId, "idle");
      await this.sendSettingsMenu(chatId);
    } else if (text.includes("شروع اسکن فوری") || text.includes("scan now") || text === "/scan") {
      await this.triggerScan(chatId);
    } else if (text.includes("توقف اسکن") || text.includes("فعال‌سازی اسکن") || text.includes("toggle") || text === "/toggle") {
      const isActive = this.settingsRepo.isMonitoringActive();
      if (isActive) {
        this.orchestrator.pauseMonitoring();
        await this.sendMessage(chatId, "🔴 اسکن خودکار متوقف شد. (Monitoring Paused)", undefined, this.getPersistentReplyKeyboard());
      } else {
        this.orchestrator.resumeMonitoring();
        await this.sendMessage(chatId, "🟢 اسکن خودکار فعال شد. (Monitoring Resumed)", undefined, this.getPersistentReplyKeyboard());
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
    } else if (data === "toggle_monitoring") {
      const isCurrentlyActive = this.settingsRepo.isMonitoringActive();
      if (isCurrentlyActive) {
        this.orchestrator.pauseMonitoring();
      } else {
        this.orchestrator.resumeMonitoring();
      }
      await this.editMessage(chatId, messageId, this.getMainMenuText(), this.getMainMenuInlineKeyboard());
      // Refresh bottom persistent keyboard
      await this.sendMessage(chatId, isCurrentlyActive ? "🔴 وضعیت اسکن: متوقف شد" : "🟢 وضعیت اسکن: فعال شد", undefined, this.getPersistentReplyKeyboard());
    } else if (data === "trigger_scan") {
      await this.sendMessage(chatId, "🔍 در حال اسکن کانال‌ها و تست اتصال کانفیگ‌ها...");
      this.orchestrator
        .triggerManualScan()
        .then(() => {
          this.sendMessage(chatId, "✅ اسکن و ارسال کانفیگ‌های سالم با موفقیت انجام شد!");
        })
        .catch((err) => {
          this.sendMessage(chatId, `❌ خطا در اجرای اسکن: ${err.message}`);
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
        "➕ **افزودن کانال جدید برای اسکن**\n\n" +
          "آیدی یا یوزرنیم کانال مورد نظر را ارسال کنید (مثلاً `@proxy_channel` یا چندین کانال با کاما):\n\n" +
          "_(برای لغو عبارت /cancel را ارسال کنید)_"
      );
    } else if (data === "menu_remove_channel") {
      await this.editMessage(
        chatId,
        messageId,
        "➖ **روی کانال مورد نظر کلیک کنید تا حذف شود:**",
        this.getRemoveChannelsKeyboard()
      );
    } else if (data.startsWith("del_chan:")) {
      const targetChan = data.replace("del_chan:", "");
      this.settingsRepo.removeAllowedChannel(targetChan);
      await this.editMessage(
        chatId,
        messageId,
        `✅ کانال \`${targetChan}\` با موفقیت حذف شد!\n\n` + this.getChannelsMenuText(),
        this.getChannelsMenuKeyboard()
      );
    } else if (data === "menu_interval") {
      await this.editMessage(
        chatId,
        messageId,
        `⏱️ **تغییر زمان‌بندی اسکن و ارسال**\n\nزمان فعلی: **هر ${this.settingsRepo.getScanIntervalMinutes()} دقیقه**\n\nیک زمان را انتخاب کنید یا مقدار دلخواه بزنید:`,
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
      await this.sendMessage(chatId, "⏱️ زمان اسکن را به دقیقه ارسال کنید (مثلاً `20` یا `45`):\n\n_(برای لغو /cancel بزنید)_");
    } else if (data === "menu_footer_text") {
      const current = this.settingsRepo.getCustomPostText();
      const textMsg =
        `✍️ **متن دلخواه انتهای پست‌ها**\n\n` +
        (current ? `متن فعلی:\n_${current}_\n\n` : `_هیچ متن سفارشی تنظیم نشده است._\n\n`) +
        `این متن با یک خط فاصله قبل از آیدی کانال (\`${this.settingsRepo.getCustomRemarks()}\`) قرار می‌گیرد.`;
      await this.editMessage(chatId, messageId, textMsg, this.getFooterTextKeyboard());
    } else if (data === "set_footer_text") {
      this.userStates.set(fromId, "waiting_for_custom_text");
      await this.sendMessage(
        chatId,
        "✍️ متنی که می‌خواهید در انتهای پست‌ها (قبل از آیدی کانال) قرار بگیرد را ارسال کنید:\n\n_(برای لغو /cancel بزنید)_"
      );
    } else if (data === "clear_footer_text") {
      this.settingsRepo.setCustomPostText("");
      await this.editMessage(
        chatId,
        messageId,
        "🗑️ متن سفارشی حذف شد!\n\n" + this.getSettingsMenuText(),
        this.getSettingsMenuKeyboard()
      );
    } else if (data === "menu_max_posts") {
      await this.editMessage(
        chatId,
        messageId,
        `🔢 **حداکثر تعداد پست در هر اسکن**\n\nتعداد فعلی: **${this.settingsRepo.getMaxPostsPerCycle()} پست**\n\nتعداد کانفیگ سالم برای ارسال در هر دور را انتخاب کنید:`,
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
      await this.sendMessage(chatId, "🔢 حداکثر تعداد پست برای ارسال در هر اسکن را ارسال کنید (مثلاً `8`):\n\n_(برای لغو /cancel بزنید)_");
    } else if (data === "menu_remarks") {
      this.userStates.set(fromId, "waiting_for_custom_remarks");
      await this.sendMessage(
        chatId,
        `🏷️ **تغییر نام رمارک کانفیگ‌ها**\n\nنام فعلی: \`${this.settingsRepo.getCustomRemarks()}\`\n\nنام رمارک جدید را ارسال کنید (مثلاً \`@connexy_private\`):\n\n_(برای لغو /cancel بزنید)_`
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
    const pingStatus = this.settingsRepo.isIncludePingInPost() ? "🟢 روشن (ON)" : "🔴 خاموش (OFF)";
    const customText = this.settingsRepo.getCustomPostText() ? "✅ تنظیم شده" : "ندارد";

    return (
      `🤖 **کنترل پنل ربات مانیتورینگ VPN**\n\n` +
      `⚡ **وضعیت ربات:** ${isActive ? "🟢 `فعال و در حال اجرا`" : "🔴 `متوقف شده`"}\n` +
      `⏱️ **فاصله زمانی اسکن:** هر **${interval} دقیقه**\n` +
      `📢 **کانال‌های تحت بررسی:** **${channels.length > 0 ? `${channels.length} کانال` : "تمام کانال‌های عضو شده"}**\n` +
      `🎯 **کانال مقصد:** \`${this.config.TARGET_CHANNEL_ID}\`\n` +
      `📡 **نمایش پینگ در پست:** ${pingStatus}\n` +
      `✍️ **متن دلخواه قبل آیدی:** ${customText}\n` +
      `🏷️ **رمارک کانفیگ‌ها:** \`${this.settingsRepo.getCustomRemarks()}\``
    );
  }

  private getMainMenuInlineKeyboard(): any {
    const isActive = this.settingsRepo.isMonitoringActive();
    return {
      inline_keyboard: [
        [
          {
            text: isActive ? "⏹ توقف اسکن خودکار" : "▶️ فعال‌سازی اسکن خودکار",
            callback_data: "toggle_monitoring",
          },
        ],
        [
          { text: "🚀 اسکن فوری اکنون", callback_data: "trigger_scan" },
          { text: "📊 وضعیت سرور", callback_data: "menu_status" },
        ],
        [{ text: "⚙️ ورود به تنظیمات", callback_data: "menu_settings" }],
      ],
    };
  }

  private getSettingsMenuText(): string {
    const ping = this.settingsRepo.isIncludePingInPost() ? "🟢 روشن (ON)" : "🔴 خاموش (OFF)";
    const interval = this.settingsRepo.getScanIntervalMinutes();
    const channels = this.settingsRepo.getAllowedChannels();
    const maxPosts = this.settingsRepo.getMaxPostsPerCycle();
    const remarks = this.settingsRepo.getCustomRemarks();
    const customText = this.settingsRepo.getCustomPostText();

    return (
      `⚙️ **تنظیمات ربات مانیتورینگ**\n\n` +
      `⚡ **نمایش پینگ در پست:** ${ping}\n` +
      `⏱️ **زمان اسکن:** هر ${interval} دقیقه\n` +
      `📢 **کانال‌ها (${channels.length}):** ${channels.join(", ") || "همه کانال‌ها"}\n` +
      `🔢 **حداکثر پست در هر اسکن:** ${maxPosts}\n` +
      `🏷️ **نام رمارک کانفیگ:** \`${remarks}\`\n` +
      `✍️ **متن دلخواه انتهای پست:** ${customText ? `"${customText}"` : "_تنظیم نشده_"}\n\n` +
      `گزینه مورد نظر برای تغییر را انتخاب کنید:`
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
            text: `⚡ نمایش پینگ در پست: ${pingActive ? "🟢 روشن" : "🔴 خاموش"}`,
            callback_data: "toggle_ping",
          },
        ],
        [{ text: "📢 مدیریت کانال‌های اسکن", callback_data: "menu_channels" }],
        [{ text: `⏱️ زمان اسکن (${interval} دقیقه)`, callback_data: "menu_interval" }],
        [{ text: "✍️ متن دلخواه انتهای پست", callback_data: "menu_footer_text" }],
        [{ text: `🔢 حداکثر تعداد پست (${maxPosts} عدد)`, callback_data: "menu_max_posts" }],
        [{ text: "🏷️ ویرایش رمارک کانفیگ", callback_data: "menu_remarks" }],
        [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "menu_main" }],
      ],
    };
  }

  private getChannelsMenuText(): string {
    const channels = this.settingsRepo.getAllowedChannels();
    return (
      `📢 **کانال‌های تحت بررسی برای استخراج کانفیگ**\n\n` +
      (channels.length > 0
        ? channels.map((c, i) => `${i + 1}. \`${c}\``).join("\n")
        : `_هیچ کانال خاصی تنظیم نشده (تمام کانال‌های عضو شده اسکن می‌شوند)_`) +
      `\n\nبرای افزودن یا حذف کانال از دکمه‌های زیر استفاده کنید:`
    );
  }

  private getChannelsMenuKeyboard(): any {
    const channels = this.settingsRepo.getAllowedChannels();
    const keyboard = [
      [{ text: "➕ افزودن کانال جدید", callback_data: "add_channel" }],
    ];

    if (channels.length > 0) {
      keyboard.push([{ text: "➖ حذف کانال", callback_data: "menu_remove_channel" }]);
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
    const hasText = !!this.settingsRepo.getCustomPostText();
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
      ? channels.map((c, i) => `${i + 1}. \`${c}\``).join("\n")
      : "_همه کانال‌های عضو شده_";
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

  private async triggerScan(chatId: string | number): Promise<void> {
    await this.sendMessage(chatId, "🔍 در حال اسکن کانال‌ها و تست اتصال کانفیگ‌ها...", undefined, this.getPersistentReplyKeyboard());
    this.orchestrator
      .triggerManualScan()
      .then(() => {
        this.sendMessage(chatId, "✅ اسکن و ارسال کانفیگ‌های سالم با موفقیت انجام شد!", undefined, this.getPersistentReplyKeyboard());
      })
      .catch((err) => {
        this.sendMessage(chatId, `❌ خطا در اجرای اسکن: ${err.message}`, undefined, this.getPersistentReplyKeyboard());
      });
  }

  private async sendStatus(chatId: string | number): Promise<void> {
    const allChannels = this.channelRepo.getAllChannels();
    const unposted = this.configRepo.getUnpostedHealthyConfigs(100);
    const isActive = this.settingsRepo.isMonitoringActive();
    const interval = this.settingsRepo.getScanIntervalMinutes();

    await this.sendMessage(
      chatId,
      `📊 **وضعیت سرور و ربات**\n\n` +
        `⚡ **وضعیت اجرای اسکن:** ${isActive ? "🟢 فعال و خودکار" : "🔴 متوقف شده"}\n` +
        `📡 **تعداد کانال‌ها در دیتابیس:** ${allChannels.length}\n` +
        `🟢 **کانفیگ‌های سالم آماده ارسال:** ${unposted.length}\n` +
        `🎯 **کانال ارسال:** \`${this.config.TARGET_CHANNEL_ID}\`\n` +
        `⏱️ **زمان‌بندی اسکن:** هر ${interval} دقیقه`,
      {
        inline_keyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callback_data: "menu_main" }]],
      },
      this.getPersistentReplyKeyboard()
    );
  }

  private async sendHelp(chatId: string | number): Promise<void> {
    await this.sendMessage(
      chatId,
      `❓ **راهنمای استفاده از ربات مانیتورینگ VPN**\n\n` +
        `1️⃣ **🚀 شروع اسکن فوری:** یک دور اسکن و تست کانفیگ‌ها را بلافاصله اجرا می‌کند.\n` +
        `2️⃣ **⏹ توقف / شروع خودکار:** اسکن دوره‌ای خودکار را متوقف یا مجدداً فعال می‌کند.\n` +
        `3️⃣ **⚙️ تنظیمات:** تمام تنظیمات پینگ، کانال‌ها، زمان‌بندی و متن انتهای پست را مدیریت می‌کند.\n` +
        `4️⃣ **📊 وضعیت سرور:** آمار لحظه‌ای کانفیگ‌ها و وضعیت را نشان می‌دهد.\n\n` +
        `_برای بازگشت به منوی اصلی از دکمه‌های زیر استفاده کنید._`,
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
        parse_mode: "Markdown",
      };

      if (inlineMarkup) {
        body.reply_markup = inlineMarkup;
      } else if (replyKeyboard) {
        body.reply_markup = replyKeyboard;
      } else {
        body.reply_markup = this.getPersistentReplyKeyboard();
      }

      await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
