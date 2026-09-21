import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { initDatabase, closeDatabase } from "../src/database/db.js";
import { SettingsRepository } from "../src/database/repositories/settings.repo.js";
import { TelegramPublisher } from "../src/telegram/publisher.js";
import { ConfigRepository } from "../src/database/repositories/config.repo.js";

const testDbPath = path.resolve(process.cwd(), "data/test_settings.sqlite");

describe("Dynamic Settings & Custom Footer Text", () => {
  let settingsRepo: SettingsRepository;
  const mockConfig: any = {
    TELEGRAM_API_ID: 12345,
    TELEGRAM_API_HASH: "hash",
    TELEGRAM_SESSION: "session",
    TARGET_CHANNEL_ID: "@connexy_private",
    SCAN_INTERVAL_MINUTES: 30,
    INITIAL_CHANNEL_SCAN_LIMIT: 30,
    SUBSEQUENT_CHANNEL_SCAN_LIMIT: 50,
    TESTER_CONCURRENCY: 5,
    TESTER_TIMEOUT_MS: 5000,
    TESTER_MODE: "tcp",
    TESTER_PING_URL: "http://cp.cloudflare.com/generate_204",
    MAX_HEALTHY_LATENCY_MS: 3500,
    MAX_POSTS_PER_CYCLE: 5,
    ALLOWED_CHANNELS: ["@AR14N24B"],
    EXCLUDED_CHANNELS: [],
    CUSTOM_CONFIG_REMARKS: "@connexy_private",
    INCLUDE_PING_IN_POST: false,
    TELEGRAM_BOT_TOKEN: "",
    ADMIN_USER_IDS: [],
    DATABASE_PATH: testDbPath,
    LOG_LEVEL: "info",
  };

  before(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    initDatabase(testDbPath);
    settingsRepo = new SettingsRepository(mockConfig);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it("should initialize default settings from config", () => {
    assert.strictEqual(settingsRepo.isMonitoringActive(), true);
    assert.strictEqual(settingsRepo.getScanIntervalMinutes(), 30);
    assert.strictEqual(settingsRepo.isIncludePingInPost(), false);
    assert.deepStrictEqual(settingsRepo.getAllowedChannels(), ["@AR14N24B"]);
    assert.strictEqual(settingsRepo.getCustomPostText(), "");
    assert.strictEqual(settingsRepo.getCustomRemarks(), "@connexy_private");
    assert.strictEqual(settingsRepo.getMaxPostsPerCycle(), 5);
  });

  it("should toggle monitoring active state", () => {
    settingsRepo.setMonitoringActive(false);
    assert.strictEqual(settingsRepo.isMonitoringActive(), false);

    settingsRepo.setMonitoringActive(true);
    assert.strictEqual(settingsRepo.isMonitoringActive(), true);
  });

  it("should add and remove allowed channels dynamically", () => {
    const added = settingsRepo.addAllowedChannel("@new_proxy_channel");
    assert.strictEqual(added, true);
    assert.deepStrictEqual(settingsRepo.getAllowedChannels(), ["@AR14N24B", "@new_proxy_channel"]);

    // Test duplicate avoidance
    const duplicateAdd = settingsRepo.addAllowedChannel("@new_proxy_channel");
    assert.strictEqual(duplicateAdd, false);

    const removed = settingsRepo.removeAllowedChannel("@new_proxy_channel");
    assert.strictEqual(removed, true);
    assert.deepStrictEqual(settingsRepo.getAllowedChannels(), ["@AR14N24B"]);
  });

  it("should update interval and max posts", () => {
    settingsRepo.setScanIntervalMinutes(45);
    assert.strictEqual(settingsRepo.getScanIntervalMinutes(), 45);

    settingsRepo.setMaxPostsPerCycle(8);
    assert.strictEqual(settingsRepo.getMaxPostsPerCycle(), 8);
  });

  it("should format post with custom footer text inserted before @connexy_private with space", () => {
    settingsRepo.setCustomPostText("🚀 Join our VIP network for more fast proxies!");
    settingsRepo.setIncludePingInPost(true);

    const mockClient: any = {};
    const configRepo = new ConfigRepository();
    const publisher = new TelegramPublisher(mockClient, configRepo, mockConfig, settingsRepo);

    const mockRecord: any = {
      hash: "abc123",
      protocol: "vless",
      server: "1.2.3.4",
      port: 443,
      raw_config: "vless://uuid@1.2.3.4:443#@connexy_private",
      remarks: "@connexy_private",
      parsed_details: JSON.stringify({ security: "reality" }),
      is_healthy: 1,
      latency_ms: 150,
      posted_to_channel: 0,
    };

    const formatted = publisher.formatConfigMessage(mockRecord);

    // Verify presence of ping
    assert.ok(formatted.includes("⚡️ Ping Latency: `150 ms` (🟢 Fast)"));

    // Verify presence of custom footer text
    assert.ok(formatted.includes("🚀 Join our VIP network for more fast proxies!"));

    // Verify custom text is placed before channel tag with newline separation
    const footerIndex = formatted.indexOf("🚀 Join our VIP network for more fast proxies!");
    const tagIndex = formatted.lastIndexOf("@connexy_private");
    assert.ok(footerIndex !== -1);
    assert.ok(tagIndex !== -1);
    assert.ok(footerIndex < tagIndex);
  });

  it("should format post cleanly when ping and custom text are disabled", () => {
    settingsRepo.setCustomPostText("");
    settingsRepo.setIncludePingInPost(false);

    const mockClient: any = {};
    const configRepo = new ConfigRepository();
    const publisher = new TelegramPublisher(mockClient, configRepo, mockConfig, settingsRepo);

    const mockRecord: any = {
      hash: "abc123",
      protocol: "vless",
      server: "1.2.3.4",
      port: 443,
      raw_config: "vless://uuid@1.2.3.4:443#@connexy_private",
      remarks: "@connexy_private",
      parsed_details: JSON.stringify({ security: "reality" }),
      is_healthy: 1,
      latency_ms: 150,
      posted_to_channel: 0,
    };

    const formatted = publisher.formatConfigMessage(mockRecord);

    assert.strictEqual(formatted.includes("Ping Latency"), false);
    assert.ok(formatted.endsWith("@connexy_private"));
  });
});
