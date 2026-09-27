/**
 * Persistence for user contexts, dialogue state, stored button params and
 * group menu ownership. Implement it on top of any database.
 *
 * - `get` returns the value as it was given to `set` (an object, not a JSON
 *   string), or null/undefined when missing or expired.
 * - `set` must overwrite; `ttlSeconds` (when given) is how long the key lives.
 * - `delete` of a missing key must not throw.
 *
 * Values are JSON-serializable. Check an implementation with
 * `verifyStorageAdapter` from `easytg/testing`.
 */
export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface MemoryEntry {
  value: unknown;
  expiresAt?: number;
}

/**
 * In-process storage, good for development and tests. Data is lost on restart
 * and not shared between processes — use Redis/SQL/etc. in production.
 *
 * Values are cloned on read and write so it behaves like a real (serializing)
 * store: mutating a value you got back does not change what is stored.
 */
export class MemoryStorage implements StorageAdapter {
  private entries = new Map<string, MemoryEntry>();
  private writes = 0;

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(entry.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value: structuredClone(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    // Expired entries are otherwise only dropped when read; sweep occasionally.
    if (++this.writes % 1000 === 0) this.sweep();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

/**
 * Namespace every key of an adapter, e.g. to share one Redis between bots:
 * `withPrefix(redisStorage, 'shopbot:')`.
 */
export function withPrefix(storage: StorageAdapter, prefix: string): StorageAdapter {
  if (!prefix) return storage;
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value, ttlSeconds) => storage.set(prefix + key, value, ttlSeconds),
    delete: (key) => storage.delete(prefix + key),
  };
}
