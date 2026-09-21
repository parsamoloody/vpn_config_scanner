import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";

let dbInstance: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ path: dbPath }, "Initializing SQLite database");
  const db = new Database(dbPath);

  // Performance optimizations
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT,
      username TEXT,
      last_scanned_message_id INTEGER DEFAULT 0,
      last_scanned_at INTEGER,
      configs_found_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS configs (
      hash TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      server TEXT NOT NULL,
      port INTEGER NOT NULL,
      raw_config TEXT NOT NULL,
      remarks TEXT,
      parsed_details TEXT,
      source_channel_id TEXT,
      source_channel_title TEXT,
      source_message_id INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_tested_at INTEGER,
      is_healthy INTEGER DEFAULT 0,
      latency_ms INTEGER,
      test_error TEXT,
      posted_to_channel INTEGER DEFAULT 0,
      posted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_configs_healthy_posted 
    ON configs(is_healthy, posted_to_channel);

    CREATE INDEX IF NOT EXISTS idx_configs_last_tested 
    ON configs(last_tested_at);

    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      channels_scanned INTEGER DEFAULT 0,
      messages_scanned INTEGER DEFAULT 0,
      configs_found INTEGER DEFAULT 0,
      configs_healthy INTEGER DEFAULT 0,
      configs_posted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  dbInstance = db;
  return db;
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info("Database connection closed.");
  }
}
