import { toJson, type StorageAdapter, type StoredTask, type TaskStore } from '../storage';

/** The part of a SQLite driver easytg uses: `bun:sqlite` and `better-sqlite3` both fit. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): { (...args: A): R; immediate(...args: A): R };
}

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteStorageOptions {
  /** Table name prefix: tables are `<table>_kv` and `<table>_tasks`. Default `easytg`. */
  table?: string;
}

interface TaskRow {
  id: string;
  name: string;
  payload: string;
  run_at: number;
  due_at: number;
  attempts: number;
  every: number | null;
  bot: number | null;
}

/**
 * Storage and task store on SQLite: one file, no server, safe for several
 * processes on the same machine. Pass an open database:
 *
 *   import { Database } from 'bun:sqlite';           // or: import Database from 'better-sqlite3'
 *   const storage = new SqliteStorage(new Database('bot.sqlite'));
 *   const app = new EasyTG({ storage });
 */
export class SqliteStorage implements StorageAdapter, TaskStore {
  private readonly kv: string;
  private readonly tasks: string;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(
    private readonly db: SqliteDatabase,
    options: SqliteStorageOptions = {},
  ) {
    const table = options.table ?? 'easytg';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name "${table}"`);
    this.kv = `${table}_kv`;
    this.tasks = `${table}_tasks`;
    db.exec('PRAGMA busy_timeout = 5000');
    enableWal(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.kv} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.tasks} (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, run_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, every INTEGER, bot INTEGER)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${this.tasks}_run_at ON ${this.tasks} (run_at)`);
  }

  async get(key: string): Promise<unknown> {
    const row = this.sql(`SELECT value FROM ${this.kv} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`).get(key, Date.now()) as
      | { value: string }
      | null
      | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.sql(
      `INSERT INTO ${this.kv} (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    ).run(key, toJson(value), expiry(ttlMs));
  }

  async delete(key: string): Promise<void> {
    this.sql(`DELETE FROM ${this.kv} WHERE key = ?`).run(key);
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const now = Date.now();
    const row = this.sql(
      `INSERT INTO ${this.kv} (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN excluded.value ELSE CAST(value AS REAL) + excluded.value END,
         expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN excluded.expires_at ELSE expires_at END
       RETURNING value`,
    ).get(key, by, expiry(ttlMs), now, now) as { value: string | number };
    return Number(row.value);
  }

  async setIfAbsent(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const result = this.sql(
      `INSERT INTO ${this.kv} (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
       WHERE ${this.kv}.expires_at IS NOT NULL AND ${this.kv}.expires_at <= ?`,
    ).run(key, toJson(value), expiry(ttlMs), Date.now());
    return Number(result.changes) > 0;
  }

  async saveTask(task: StoredTask): Promise<void> {
    this.writeTask(task);
  }

  private writeTask(task: StoredTask) {
    this.sql(
      `INSERT OR REPLACE INTO ${this.tasks} (id, name, payload, run_at, due_at, attempts, every, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.id, task.name, toJson(task.payload ?? null), task.runAt, task.dueAt, task.attempts, task.everyMs ?? null, task.bot ?? null);
  }

  async claimTasks(now: number, limit: number, leaseMs: number): Promise<StoredTask[]> {
    const claim = this.db.transaction(() => {
      const rows = this.sql(`SELECT * FROM ${this.tasks} WHERE run_at <= ? ORDER BY run_at LIMIT ?`).all(now, limit) as TaskRow[];
      const update = this.sql(`UPDATE ${this.tasks} SET run_at = ?, attempts = attempts + 1 WHERE id = ?`);
      for (const row of rows) update.run(now + leaseMs, row.id);
      return rows;
    });
    // IMMEDIATE: take the write lock up front, so two processes can't claim the same rows.
    return claim.immediate().map((row) => ({
      id: row.id,
      name: row.name,
      payload: JSON.parse(row.payload),
      runAt: now + leaseMs,
      dueAt: Number(row.due_at),
      attempts: Number(row.attempts) + 1,
      // Number(): drivers with safeIntegers return bigint.
      everyMs: row.every == null ? undefined : Number(row.every),
      bot: row.bot == null ? undefined : Number(row.bot),
    }));
  }

  async finishTask(claimed: StoredTask, next?: StoredTask): Promise<void> {
    const finish = this.db.transaction(() => {
      const current = this.sql(`SELECT run_at FROM ${this.tasks} WHERE id = ?`).get(claimed.id) as { run_at: number } | null | undefined;
      if (!current || Number(current.run_at) !== claimed.runAt) return;
      if (next) this.writeTask(next);
      else this.sql(`DELETE FROM ${this.tasks} WHERE id = ?`).run(claimed.id);
    });
    finish.immediate();
  }

  async deleteTask(id: string): Promise<boolean> {
    return Number(this.sql(`DELETE FROM ${this.tasks} WHERE id = ?`).run(id).changes) > 0;
  }

  /** Expired keys are ignored on read; call this now and then to reclaim space. */
  purgeExpired() {
    this.sql(`DELETE FROM ${this.kv} WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(Date.now());
  }

  private sql(query: string): SqliteStatement {
    let statement = this.statements.get(query);
    if (!statement) this.statements.set(query, (statement = this.db.prepare(query)));
    return statement;
  }
}

/**
 * Switch to WAL (readers don't block the writer). The switch itself doesn't
 * wait for busy_timeout, so when several processes open a new database at
 * once, try again for a moment.
 */
function enableWal(db: SqliteDatabase) {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (attempt >= 50 || !String(error).includes('locked')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // sleep, synchronously (Node and Bun)
    }
  }
}

function expiry(ttlMs?: number) {
  return ttlMs ? Math.round(Date.now() + ttlMs) : null;
}
