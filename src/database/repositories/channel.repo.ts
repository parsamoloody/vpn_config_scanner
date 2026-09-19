import Database from "better-sqlite3";
import { getDatabase } from "../db.js";

export interface ChannelRecord {
  id: string;
  title: string;
  username: string | null;
  last_scanned_message_id: number;
  last_scanned_at: number | null;
  configs_found_count: number;
}

export class ChannelRepository {
  private get db(): Database.Database {
    return getDatabase();
  }

  getChannel(id: string): ChannelRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE id = ?");
    return stmt.get(id) as ChannelRecord | undefined;
  }

  upsertChannel(id: string, title: string, username?: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO channels (id, title, username)
      VALUES (@id, @title, @username)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        username = excluded.username
    `);
    stmt.run({ id, title, username: username || null });
  }

  updateScanProgress(id: string, lastMessageId: number, newConfigsCount = 0): void {
    const stmt = this.db.prepare(`
      UPDATE channels
      SET 
        last_scanned_message_id = MAX(last_scanned_message_id, @lastMessageId),
        last_scanned_at = @now,
        configs_found_count = configs_found_count + @newConfigsCount
      WHERE id = @id
    `);
    stmt.run({
      id,
      lastMessageId,
      newConfigsCount,
      now: Date.now(),
    });
  }

  getAllChannels(): ChannelRecord[] {
    const stmt = this.db.prepare("SELECT * FROM channels ORDER BY last_scanned_at ASC");
    return stmt.all() as ChannelRecord[];
  }
}
