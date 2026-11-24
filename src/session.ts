/**
 * Declare your session keys to type `session.get` / `session.set`:
 *
 *   declare module 'easytg' {
 *     interface SessionData { cart: string[]; plan: 'free' | 'pro' }
 *   }
 *
 * Keys not declared here stay untyped (`get<T>(key)`).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SessionData {}

type Key = keyof SessionData & string;
/** A key that isn't declared in `SessionData`. */
type Undeclared<K extends string> = K extends Key ? never : K;

export interface SessionSetOptions {
  /** Forget this key after this many ms (independent of the session's own TTL). */
  ttlMs?: number;
}

/** How a session is kept in storage. */
export interface StoredSession {
  data: Record<string, unknown>;
  meta: {
    /** Format version, for future migrations. */
    v: 1;
    /** When the session was last written (ms). */
    savedAt: number;
    /** Per-key expiry times (ms). */
    expires?: Record<string, number>;
    /** The app's own schema version (`session.version`), for migrations. */
    app?: number;
  };
}

/**
 * Per user, per chat key/value state. Reads and writes are synchronous; changes
 * are saved once at the end of the update (or of `app.open` / `app.sendTo`).
 * Values must be JSON-serializable. A value changed in place
 * (`session.get('cart')!.push(item)`) is saved too, like one passed to `set`.
 */
export class Session {
  /** @internal */
  dirty = false;
  /** @internal When it was last written to storage (ms), if ever. */
  savedAt?: number;

  private data: Record<string, unknown>;
  private expires: Record<string, number>;
  /** Keys set or deleted since loading, for merging into a newer stored copy. */
  private readonly changed = new Set<string>();
  /** Each key's value as loaded (JSON), to notice values changed in place. */
  private snapshot = new Map<string, string>();
  /** @internal The app's schema version the data is in. */
  version?: number;

  /** @internal */
  constructor(stored?: unknown) {
    const parsed = parse(stored);
    this.data = parsed?.data ?? {};
    this.expires = parsed?.meta.expires ?? {};
    this.savedAt = parsed?.meta.savedAt;
    this.version = parsed?.meta.app;
    this.takeSnapshot();
  }

  /**
   * @internal Values changed in place since loading (`get(key).push(…)`)
   * count as set: mark them, so they are saved and merged like `set`.
   */
  detectChanges() {
    for (const [key, value] of Object.entries(this.data)) {
      if (this.changed.has(key)) continue;
      if (this.snapshot.get(key) !== json(value)) {
        this.changed.add(key);
        this.dirty = true;
      }
    }
  }

  private takeSnapshot() {
    this.snapshot = new Map(Object.entries(this.data).map(([key, value]) => [key, json(value)]));
  }

  /** @internal Bring stored data to the app's current schema version. */
  migrate(version: number, migrate: ((data: Record<string, unknown>, from: number) => Record<string, unknown>) | undefined) {
    if (this.version === version) return;
    if (this.isEmpty) {
      this.version = version; // nothing to migrate: new users start at the current version
      return;
    }
    if (migrate) {
      const before = Object.keys(this.data);
      this.data = { ...migrate({ ...this.data }, this.version ?? 0) };
      // Every key the migration may have touched, so a merged save writes the migrated data.
      for (const key of [...before, ...Object.keys(this.data)]) this.changed.add(key);
    }
    this.version = version;
    this.dirty = true;
  }

  get<K extends Key>(key: K): SessionData[K] | undefined;
  get<T = unknown, K extends string = string>(key: Undeclared<K>): T | undefined;
  get(key: string): unknown {
    return this.alive(key) ? this.data[key] : undefined;
  }

  has(key: string): boolean {
    return this.alive(key);
  }

  set<K extends Key>(key: K, value: SessionData[K], options?: SessionSetOptions): void;
  set<K extends string>(key: Undeclared<K>, value: unknown, options?: SessionSetOptions): void;
  set(key: string, value: unknown, options?: SessionSetOptions): void {
    this.data[key] = value;
    if (options?.ttlMs) this.expires[key] = Date.now() + options.ttlMs;
    else delete this.expires[key];
    this.changed.add(key);
    this.dirty = true;
  }

  setMany(values: Partial<SessionData> & Record<string, unknown>, options?: SessionSetOptions): void {
    for (const [key, value] of Object.entries(values)) this.set(key as never, value as never, options);
  }

  delete(...keys: string[]): void {
    for (const key of keys) {
      if (!Object.hasOwn(this.data, key)) continue;
      delete this.data[key];
      delete this.expires[key];
      this.changed.add(key);
      this.dirty = true;
    }
  }

  keys(): string[] {
    return Object.keys(this.data).filter((key) => this.alive(key));
  }

  /** Current (non-expired) values. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.keys().map((key) => [key, this.data[key]]));
  }

  /** @internal */
  get isEmpty() {
    return this.keys().length === 0;
  }

  /**
   * @internal For sessions several updates may change at once (per user
   * across chats, per chat): apply only this update's changes on top of what
   * is stored now, so changes to other keys made meanwhile aren't lost.
   */
  mergeWith(stored: unknown) {
    // What is stored now (nothing, if it was deleted meanwhile), plus only this update's changes.
    const latest = parse(stored);
    const data = latest?.data ?? {};
    const expires = latest?.meta.expires ?? {};
    for (const key of this.changed) {
      if (Object.hasOwn(this.data, key)) {
        data[key] = this.data[key];
        if (this.expires[key] !== undefined) expires[key] = this.expires[key]!;
        else delete expires[key];
      } else {
        delete data[key];
        delete expires[key];
      }
    }
    this.data = data;
    this.expires = expires;
    this.changed.clear();
    this.takeSnapshot();
  }

  /** @internal */
  serialize(now: number): StoredSession {
    this.keys(); // drops expired keys
    const expires = Object.keys(this.expires).length ? { ...this.expires } : undefined;
    // Saved: later in-place changes are compared to this.
    this.changed.clear();
    this.takeSnapshot();
    return { data: { ...this.data }, meta: { v: 1, savedAt: now, expires, app: this.version } };
  }

  private alive(key: string): boolean {
    if (!Object.hasOwn(this.data, key)) return false;
    const expiresAt = this.expires[key];
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      delete this.data[key];
      delete this.expires[key];
      this.dirty = true;
      return false;
    }
    return true;
  }
}

/** A value's JSON, to compare it with an earlier one (`undefined` for what can't be serialized). */
function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
}

function parse(stored: unknown): StoredSession | null {
  if (!stored || typeof stored !== 'object') return null;
  const { data, meta } = stored as Partial<StoredSession>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return {
    data: { ...data },
    meta: {
      v: 1,
      savedAt: typeof meta?.savedAt === 'number' ? meta.savedAt : 0,
      expires: meta?.expires && typeof meta.expires === 'object' ? { ...meta.expires } : undefined,
      app: typeof meta?.app === 'number' ? meta.app : undefined,
    },
  };
}
