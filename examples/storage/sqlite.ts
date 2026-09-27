import { Database } from 'bun:sqlite';
import type { StorageAdapter } from '../../src';

/**
 * Example StorageAdapter on SQLite (built into Bun, no extra dependency).
 * The same three methods can be implemented on Postgres, MySQL, Redis, Mongo...
 */
export class SqliteStorage implements StorageAdapter {
  private db: Database;

  constructor(path = 'easytg.sqlite') {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`CREATE TABLE IF NOT EXISTS easytg_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )`);
  }

  async get(key: string): Promise<unknown> {
    const row = this.db
      .query<{ value: string; expires_at: number | null }, [string]>('SELECT value, expires_at FROM easytg_kv WHERE key = ?')
      .get(key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.delete(key);
      return null;
    }
    return JSON.parse(row.value);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.db
      .query(`INSERT INTO easytg_kv (key, value, expires_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
      .run(key, JSON.stringify(value), ttlSeconds ? Date.now() + ttlSeconds * 1000 : null);
  }

  async delete(key: string): Promise<void> {
    this.db.query('DELETE FROM easytg_kv WHERE key = ?').run(key);
  }

  /** Expired rows are dropped lazily on read; call this periodically to reclaim space. */
  purgeExpired() {
    this.db.query('DELETE FROM easytg_kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now());
  }

  close() {
    this.db.close();
  }
}
