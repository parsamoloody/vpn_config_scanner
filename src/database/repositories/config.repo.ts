import Database from "better-sqlite3";
import { getDatabase } from "../db.js";

export interface ConfigRecord {
  hash: string;
  protocol: string;
  server: string;
  port: number;
  raw_config: string;
  remarks: string | null;
  parsed_details: string | null;
  source_channel_id: string | null;
  source_channel_title: string | null;
  source_message_id: number | null;
  first_seen_at: number;
  last_tested_at: number | null;
  is_healthy: number;
  latency_ms: number | null;
  test_error: string | null;
  posted_to_channel: number;
  posted_at: number | null;
}

export class ConfigRepository {
  private get db(): Database.Database {
    return getDatabase();
  }

  saveConfig(data: {
    hash: string;
    protocol: string;
    server: string;
    port: number;
    rawConfig: string;
    remarks?: string | null;
    parsedDetails?: Record<string, unknown>;
    sourceChannelId?: string;
    sourceChannelTitle?: string;
    sourceMessageId?: number;
  }): { isNew: boolean } {
    const existing = this.getConfigByHash(data.hash);
    if (existing) {
      return { isNew: false };
    }

    const stmt = this.db.prepare(`
      INSERT INTO configs (
        hash, protocol, server, port, raw_config, remarks,
        parsed_details, source_channel_id, source_channel_title,
        source_message_id, first_seen_at
      ) VALUES (
        @hash, @protocol, @server, @port, @rawConfig, @remarks,
        @parsedDetails, @sourceChannelId, @sourceChannelTitle,
        @sourceMessageId, @firstSeenAt
      )
    `);

    stmt.run({
      hash: data.hash,
      protocol: data.protocol,
      server: data.server,
      port: data.port,
      rawConfig: data.rawConfig,
      remarks: data.remarks || null,
      parsedDetails: data.parsedDetails ? JSON.stringify(data.parsedDetails) : null,
      sourceChannelId: data.sourceChannelId || null,
      sourceChannelTitle: data.sourceChannelTitle || null,
      sourceMessageId: data.sourceMessageId || null,
      firstSeenAt: Date.now(),
    });

    return { isNew: true };
  }

  getConfigByHash(hash: string): ConfigRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM configs WHERE hash = ?");
    return stmt.get(hash) as ConfigRecord | undefined;
  }

  isConfigPosted(hash: string): boolean {
    const stmt = this.db.prepare("SELECT posted_to_channel FROM configs WHERE hash = ?");
    const res = stmt.get(hash) as { posted_to_channel: number } | undefined;
    return !!res && res.posted_to_channel === 1;
  }

  updateTestResult(hash: string, isHealthy: boolean, latencyMs?: number | null, testError?: string | null): void {
    const stmt = this.db.prepare(`
      UPDATE configs
      SET 
        last_tested_at = @now,
        is_healthy = @isHealthy,
        latency_ms = @latencyMs,
        test_error = @testError
      WHERE hash = @hash
    `);
    stmt.run({
      hash,
      now: Date.now(),
      isHealthy: isHealthy ? 1 : 0,
      latencyMs: latencyMs ?? null,
      testError: testError ?? null,
    });
  }

  markAsPosted(hash: string): void {
    const stmt = this.db.prepare(`
      UPDATE configs
      SET 
        posted_to_channel = 1,
        posted_at = @now
      WHERE hash = @hash
    `);
    stmt.run({
      hash,
      now: Date.now(),
    });
  }

  getUnpostedConfigs(limit = 50, requireHealthy = true): ConfigRecord[] {
    const where = requireHealthy ? "WHERE is_healthy = 1 AND posted_to_channel = 0" : "WHERE posted_to_channel = 0";
    const orderBy = requireHealthy ? "ORDER BY latency_ms ASC, first_seen_at DESC" : "ORDER BY first_seen_at DESC";
    const stmt = this.db.prepare(`
      SELECT * FROM configs 
      ${where}
      ${orderBy}
      LIMIT ?
    `);
    return stmt.all(limit) as ConfigRecord[];
  }

  getUnpostedHealthyConfigs(limit = 50): ConfigRecord[] {
    return this.getUnpostedConfigs(limit, true);
  }

  startScanRun(): number {
    const stmt = this.db.prepare(`
      INSERT INTO scan_runs (started_at) VALUES (?)
    `);
    const res = stmt.run(Date.now());
    return Number(res.lastInsertRowid);
  }

  finishScanRun(runId: number, stats: {
    channelsScanned: number;
    messagesScanned: number;
    configsFound: number;
    configsHealthy: number;
    configsPosted: number;
  }): void {
    const stmt = this.db.prepare(`
      UPDATE scan_runs
      SET 
        finished_at = @now,
        channels_scanned = @channelsScanned,
        messages_scanned = @messagesScanned,
        configs_found = @configsFound,
        configs_healthy = @configsHealthy,
        configs_posted = @configsPosted
      WHERE id = @runId
    `);
    stmt.run({
      runId,
      now: Date.now(),
      ...stats,
    });
  }
}
