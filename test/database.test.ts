import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { initDatabase, closeDatabase } from "../src/database/db.js";
import { ConfigRepository } from "../src/database/repositories/config.repo.js";
import { ChannelRepository } from "../src/database/repositories/channel.repo.js";

const testDbPath = path.resolve(process.cwd(), "data/test_vpn.sqlite");

describe("Database & Repositories", () => {
  before(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    initDatabase(testDbPath);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it("should track channel scan progress", () => {
    const repo = new ChannelRepository();
    repo.upsertChannel("-100123456", "Test Channel", "test_channel");

    const ch = repo.getChannel("-100123456");
    assert.ok(ch);
    assert.strictEqual(ch.title, "Test Channel");
    assert.strictEqual(ch.last_scanned_message_id, 0);

    repo.updateScanProgress("-100123456", 150, 5);
    const updated = repo.getChannel("-100123456");
    assert.ok(updated);
    assert.strictEqual(updated.last_scanned_message_id, 150);
    assert.strictEqual(updated.configs_found_count, 5);
  });

  it("should save and deduplicate VPN configs", () => {
    const repo = new ConfigRepository();
    const hash = "test-hash-12345";

    const res1 = repo.saveConfig({
      hash,
      protocol: "vless",
      server: "1.2.3.4",
      port: 443,
      rawConfig: "vless://uuid@1.2.3.4:443#Test",
      sourceChannelId: "-100123456",
      sourceChannelTitle: "Test Channel",
    });
    assert.strictEqual(res1.isNew, true);

    const res2 = repo.saveConfig({
      hash,
      protocol: "vless",
      server: "1.2.3.4",
      port: 443,
      rawConfig: "vless://uuid@1.2.3.4:443#Test2",
    });
    assert.strictEqual(res2.isNew, false);

    assert.strictEqual(repo.isConfigPosted(hash), false);

    repo.updateTestResult(hash, true, 120, null);
    const config = repo.getConfigByHash(hash);
    assert.ok(config);
    assert.strictEqual(config.is_healthy, 1);
    assert.strictEqual(config.latency_ms, 120);

    const unposted = repo.getUnpostedHealthyConfigs();
    assert.strictEqual(unposted.length, 1);
    assert.strictEqual(unposted[0].hash, hash);

    repo.markAsPosted(hash);
    assert.strictEqual(repo.isConfigPosted(hash), true);

    const unpostedAfter = repo.getUnpostedHealthyConfigs();
    assert.strictEqual(unpostedAfter.length, 0);
  });
});
