/**
 * Persistence for sessions, dialogue state, stored button params and message
 * metadata. Implement it on top of any database, or use a built-in adapter:
 * `MemoryStorage`, `SqliteStorage`, `RedisStorage`.
 *
 * - `get` returns the value as it was given to `set` (an object, not a JSON
 *   string), or null/undefined when missing or expired.
 * - `set` must overwrite; `ttlMs` (when given) is how long the key lives, in ms.
 * - `delete` of a missing key must not throw.
 *
 * `increment` and `setIfAbsent` are optional and must be atomic. They are
 * needed for `cluster` (rate limits and locks shared by several processes).
 *
 * Values are JSON-serializable. Check an implementation with
 * `verifyStorageAdapter` from `easytg/testing`.
 */
export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Add `by` to the number at `key` (missing or expired = 0) and return the
   * result. `ttlMs` applies only when the key is created.
   */
  increment?(key: string, by: number, ttlMs?: number): Promise<number>;
  /** Set `key` only if it doesn't exist (or has expired). Returns whether it was set. */
  setIfAbsent?(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
}

/** A scheduled task as a `TaskStore` keeps it. */
export interface StoredTask {
  /** Unique; saving a task with an existing id replaces it. */
  id: string;
  /** The registered task (`task(name)`). */
  name: string;
  payload: unknown;
  /** When it is due (ms timestamp). While claimed: when the claim expires. */
  runAt: number;
  /** When it was due, kept while claimed (`runAt` is then the claim's end). */
  dueAt: number;
  /** Runs started so far (including failed ones). */
  attempts: number;
  /** Repeat interval in ms, for recurring tasks. */
  everyMs?: number;
  /** Id of the bot the task was scheduled for. */
  bot?: number;
}

/**
 * Durable storage for scheduled tasks (`app.schedule`). The built-in adapters
 * implement it next to `StorageAdapter`; all methods must be atomic, since
 * several processes may poll the same store.
 */
export interface TaskStore {
  /** Insert, or replace the task with the same id. */
  saveTask(task: StoredTask): Promise<void>;
  /**
   * Claim up to `limit` tasks due at `now`, earliest first: their `runAt`
   * becomes `now + leaseMs` and `attempts` goes up by one (all other fields
   * stay as saved). Return them as updated. A claimed task that isn't
   * finished in time is claimed again.
   */
  claimTasks(now: number, limit: number, leaseMs: number): Promise<StoredTask[]>;
  /**
   * Finish a claimed task: delete it, or replace it with `next` (a retry or the
   * next run). No-op when the task was claimed again or replaced since (its
   * `runAt` differs from `claimed.runAt`).
   */
  finishTask(claimed: StoredTask, next?: StoredTask): Promise<void>;
  /** Remove a task. Returns whether it existed. */
  deleteTask(id: string): Promise<boolean>;
}

export function isTaskStore(value: unknown): value is TaskStore {
  const store = value as Partial<TaskStore> | null;
  return !!store && typeof store.saveTask === 'function' && typeof store.claimTasks === 'function';
}

interface MemoryEntry {
  /** JSON, like a real store keeps it. */
  json: string;
  expiresAt?: number;
}

/** JSON-encode a value to store; `undefined` can't be stored (use `delete`). */
export function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Storage values must be JSON-serializable (got undefined or a function); use delete() to remove a key');
  return json;
}

/**
 * In-process storage, good for development and tests. Data is lost on restart
 * and not shared between processes — use `SqliteStorage`, `RedisStorage` or
 * your own adapter in production.
 *
 * Values are kept as JSON, exactly like the real adapters: a `Date` comes
 * back as a string, a `Map` as `{}`, and mutating a value you got back
 * doesn't change what is stored. Tests on it catch what would break on
 * SQLite or Redis.
 */
export class MemoryStorage implements StorageAdapter, TaskStore {
  private entries = new Map<string, MemoryEntry>();
  private tasks = new Map<string, string>();
  private writes = 0;

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (JSON.parse(entry.json) as T) : null;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.entries.set(key, { json: toJson(value), expiresAt: expiry(ttlMs) });
    // Expired entries are otherwise only dropped when read; sweep occasionally.
    if (++this.writes % 1000 === 0) this.sweep();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const entry = this.live(key);
    const current = entry ? JSON.parse(entry.json) : 0;
    const value = (typeof current === 'number' ? current : 0) + by;
    if (entry) entry.json = JSON.stringify(value);
    else await this.set(key, value, ttlMs);
    return value;
  }

  async setIfAbsent(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  get size() {
    return this.entries.size;
  }

  async saveTask(task: StoredTask): Promise<void> {
    this.tasks.set(task.id, toJson(task));
  }

  async claimTasks(now: number, limit: number, leaseMs: number): Promise<StoredTask[]> {
    const due = [...this.tasks.values()]
      .map((json) => JSON.parse(json) as StoredTask)
      .filter((t) => t.runAt <= now)
      .sort((a, b) => a.runAt - b.runAt);
    return due.slice(0, limit).map((task) => {
      task.runAt = now + leaseMs;
      task.attempts += 1;
      this.tasks.set(task.id, JSON.stringify(task));
      return task;
    });
  }

  async finishTask(claimed: StoredTask, next?: StoredTask): Promise<void> {
    const stored = this.tasks.get(claimed.id);
    if (!stored || (JSON.parse(stored) as StoredTask).runAt !== claimed.runAt) return;
    if (next) this.tasks.set(next.id, toJson(next));
    else this.tasks.delete(claimed.id);
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.tasks.delete(id);
  }

  private live(key: string): MemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

function expiry(ttlMs?: number) {
  return ttlMs ? Date.now() + ttlMs : undefined;
}

/**
 * Namespace every key of an adapter, e.g. to share one Redis between bots:
 * `withPrefix(redisStorage, 'shopbot:')`. Scheduled tasks are not prefixed.
 */
export function withPrefix(storage: StorageAdapter, prefix: string): StorageAdapter {
  if (!prefix) return storage;
  const prefixed: StorageAdapter = {
    get: (key) => storage.get(prefix + key),
    set: (key, value, ttlMs) => storage.set(prefix + key, value, ttlMs),
    delete: (key) => storage.delete(prefix + key),
  };
  if (storage.increment) prefixed.increment = (key, by, ttl) => storage.increment!(prefix + key, by, ttl);
  if (storage.setIfAbsent) prefixed.setIfAbsent = (key, value, ttl) => storage.setIfAbsent!(prefix + key, value, ttl);
  return prefixed;
}
