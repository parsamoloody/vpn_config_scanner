import Database from "better-sqlite3";
import { Config } from "../../config/env.js";
import { getDatabase } from "../db.js";

export class SettingsRepository {
  private cache = new Map<string, string>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.loadFromDb();
  }

  private get db(): Database.Database {
    return getDatabase();
  }

  private loadFromDb(): void {
    const stmt = this.db.prepare("SELECT key, value FROM settings");
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      this.cache.set(row.key, row.value);
    }
  }

  get(key: string, defaultValue: string): string {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    return defaultValue;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run({ key, value });
  }

  // --- Strongly-typed Helpers ---

  isMonitoringActive(): boolean {
    const val = this.get("is_monitoring_active", "true");
    return val === "true";
  }

  setMonitoringActive(active: boolean): void {
    this.set("is_monitoring_active", active ? "true" : "false");
  }

  getScanIntervalMinutes(): number {
    const defaultVal = this.config.SCAN_INTERVAL_MINUTES.toString();
    const val = this.get("scan_interval_minutes", defaultVal);
    const num = parseInt(val, 10);
    return isNaN(num) || num <= 0 ? this.config.SCAN_INTERVAL_MINUTES : num;
  }

  setScanIntervalMinutes(minutes: number): void {
    this.set("scan_interval_minutes", Math.max(1, minutes).toString());
  }

  isIncludePingInPost(): boolean {
    const defaultVal = this.config.INCLUDE_PING_IN_POST ? "true" : "false";
    const val = this.get("include_ping_in_post", defaultVal);
    return val === "true";
  }

  setIncludePingInPost(include: boolean): void {
    this.set("include_ping_in_post", include ? "true" : "false");
  }

  getAllowedChannels(): string[] {
    const defaultVal = JSON.stringify(this.config.ALLOWED_CHANNELS || []);
    const raw = this.get("allowed_channels", defaultVal);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
    return this.config.ALLOWED_CHANNELS || [];
  }

  setAllowedChannels(channels: string[]): void {
    const cleaned = channels.map((c) => c.trim()).filter(Boolean);
    this.set("allowed_channels", JSON.stringify(cleaned));
  }

  addAllowedChannel(channel: string): boolean {
    const current = this.getAllowedChannels();
    const clean = channel.trim();
    if (!clean) return false;

    // Avoid duplicates
    if (!current.some((c) => c.toLowerCase() === clean.toLowerCase())) {
      current.push(clean);
      this.setAllowedChannels(current);
      return true;
    }
    return false;
  }

  removeAllowedChannel(channel: string): boolean {
    const current = this.getAllowedChannels();
    const clean = channel.trim().toLowerCase();
    const filtered = current.filter((c) => c.trim().toLowerCase() !== clean);

    if (filtered.length !== current.length) {
      this.setAllowedChannels(filtered);
      return true;
    }
    return false;
  }

  getCustomPostText(): string {
    return this.get("custom_post_text", "");
  }

  setCustomPostText(text: string): void {
    this.set("custom_post_text", text.trim());
  }

  getCustomRemarks(): string {
    return this.get("custom_remarks", this.config.CUSTOM_CONFIG_REMARKS || "@connexy_private");
  }

  setCustomRemarks(remarks: string): void {
    this.set("custom_remarks", remarks.trim());
  }

  getMaxPostsPerCycle(): number {
    const defaultVal = this.config.MAX_POSTS_PER_CYCLE.toString();
    const val = this.get("max_posts_per_cycle", defaultVal);
    const num = parseInt(val, 10);
    return isNaN(num) || num <= 0 ? this.config.MAX_POSTS_PER_CYCLE : num;
  }

  setMaxPostsPerCycle(limit: number): void {
    this.set("max_posts_per_cycle", Math.max(1, limit).toString());
  }
}
