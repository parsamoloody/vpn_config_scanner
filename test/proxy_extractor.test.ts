import assert from "node:assert";
import { describe, it } from "node:test";
import { extractRawProxiesFromText } from "../src/extractor/regex.js";
import { parseProxyConfig } from "../src/extractor/parser.js";
import { TelegramPublisher } from "../src/telegram/publisher.js";
import { SettingsRepository } from "../src/database/repositories/settings.repo.js";
import { initDatabase, closeDatabase } from "../src/database/db.js";
import { ConfigRepository } from "../src/database/repositories/config.repo.js";
import path from "path";
import fs from "fs";

describe("Proxy Extractor & Parser", () => {
  it("should extract MTProto and Socks proxy links from message text", () => {
    const message = `
      سلام دوستان!
      پروکسی‌های جدید برای اتصال بدون فیلتر تلگرام:
      
      tg://proxy?server=198.51.100.1&port=443&secret=ee1234567890abcdef1234567890abcdef
      
      پروکسی دوم:
      https://t.me/proxy?server=203.0.113.50&port=8443&secret=ddabcdef1234567890abcdef1234567890
      
      ساکس ۵:
      https://t.me/socks?server=192.0.2.10&port=1080&user=user1&pass=pass1
      
      کانال ما: @connexy_private
    `;

    const extracted = extractRawProxiesFromText(message);
    assert.strictEqual(extracted.length, 3);
    assert.ok(extracted.some((p) => p.includes("198.51.100.1")));
    assert.ok(extracted.some((p) => p.includes("203.0.113.50")));
    assert.ok(extracted.some((p) => p.includes("192.0.2.10")));
  });

  it("should parse MTProto proxy correctly", () => {
    const raw = "https://t.me/proxy?server=1.2.3.4&port=443&secret=ee0102030405060708090a0b0c0d0e0f";
    const parsed = parseProxyConfig(raw);

    assert.ok(parsed);
    assert.strictEqual(parsed.protocol, "mtproto");
    assert.strictEqual(parsed.server, "1.2.3.4");
    assert.strictEqual(parsed.port, 443);
    assert.strictEqual(parsed.uuidOrPassword, "ee0102030405060708090a0b0c0d0e0f");
    assert.ok(parsed.normalizedHash.length > 0);
  });

  it("should parse Socks5 proxy correctly", () => {
    const raw = "https://t.me/socks?server=5.6.7.8&port=1080&user=testuser&pass=secretpass";
    const parsed = parseProxyConfig(raw);

    assert.ok(parsed);
    assert.strictEqual(parsed.protocol, "socks5");
    assert.strictEqual(parsed.server, "5.6.7.8");
    assert.strictEqual(parsed.port, 1080);
    assert.strictEqual(parsed.uuidOrPassword, "testuser:secretpass");
  });

  it("should format bundled proxies message with pipe separators and custom proxy text", () => {
    const testDbPath = path.resolve(process.cwd(), "data/test_proxy_pub.sqlite");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    initDatabase(testDbPath);

    const mockConfig: any = {
      CUSTOM_CONFIG_REMARKS: "@connexy_private",
      CUSTOM_PROXY_POST_TEXT: "🚀 پروکسی‌های پرسرعت برای دوستان خود بفرستید",
      INCLUDE_PING_IN_POST: false,
    };

    const settingsRepo = new SettingsRepository(mockConfig);
    const mockClient: any = {};
    const configRepo = new ConfigRepository();
    const publisher = new TelegramPublisher(mockClient, configRepo, mockConfig, settingsRepo);

    const proxies: any[] = [
      {
        hash: "p1",
        protocol: "mtproto",
        server: "1.1.1.1",
        port: 443,
        raw_config: "https://t.me/proxy?server=1.1.1.1&port=443&secret=ee111",
      },
      {
        hash: "p2",
        protocol: "mtproto",
        server: "2.2.2.2",
        port: 443,
        raw_config: "https://t.me/proxy?server=2.2.2.2&port=443&secret=ee222",
      },
      {
        hash: "p3",
        protocol: "mtproto",
        server: "3.3.3.3",
        port: 443,
        raw_config: "https://t.me/proxy?server=3.3.3.3&port=443&secret=ee333",
      },
    ];

    const formatted = publisher.formatProxiesMessage(proxies);

    // Verify pipe separated HTML link format
    assert.ok(
      formatted.includes(
        '<a href="https://t.me/proxy?server=1.1.1.1&amp;port=443&amp;secret=ee111">پروکسی</a> | <a href="https://t.me/proxy?server=2.2.2.2&amp;port=443&amp;secret=ee222">پروکسی</a> | <a href="https://t.me/proxy?server=3.3.3.3&amp;port=443&amp;secret=ee333">پروکسی</a>'
      )
    );

    // Verify custom proxy text is present
    assert.ok(formatted.includes("🚀 پروکسی‌های پرسرعت برای دوستان خود بفرستید"));

    // Verify remark is at the very end of post without emoji, exactly like config posts
    const linkIndex = formatted.lastIndexOf("<a href=");
    const tagIndex = formatted.lastIndexOf("@connexy_private");
    assert.ok(linkIndex !== -1);
    assert.ok(tagIndex !== -1);
    assert.ok(linkIndex < tagIndex, "Remarks must be at the end of the post, after proxy links");
    assert.ok(formatted.endsWith("@connexy_private"));
    assert.strictEqual(formatted.includes("🆔"), false);

    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });
});
