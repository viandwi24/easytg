export interface SessionSetOptions {
  /** Forget this key after this many seconds (independent of the session's own TTL). */
  ttlSeconds?: number;
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
  };
}

/**
 * Per user, per chat key/value state. Reads and writes are synchronous; changes
 * are saved once at the end of the update (or of `app.open` / `app.sendTo`).
 * Values must be JSON-serializable.
 */
export class Session {
  /** @internal */
  dirty = false;
  /** @internal When it was last written to storage (ms), if ever. */
  savedAt?: number;

  private readonly data: Record<string, unknown>;
  private readonly expires: Record<string, number>;

  /** @internal */
  constructor(stored?: unknown) {
    const parsed = parse(stored);
    this.data = parsed?.data ?? {};
    this.expires = parsed?.meta.expires ?? {};
    this.savedAt = parsed?.meta.savedAt;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.alive(key) ? (this.data[key] as T) : undefined;
  }

  has(key: string): boolean {
    return this.alive(key);
  }

  set(key: string, value: unknown, options?: SessionSetOptions): void {
    this.data[key] = value;
    if (options?.ttlSeconds) this.expires[key] = Date.now() + options.ttlSeconds * 1000;
    else delete this.expires[key];
    this.dirty = true;
  }

  setMany(values: Record<string, unknown>, options?: SessionSetOptions): void {
    for (const [key, value] of Object.entries(values)) this.set(key, value, options);
  }

  delete(...keys: string[]): void {
    for (const key of keys) {
      if (!Object.hasOwn(this.data, key)) continue;
      delete this.data[key];
      delete this.expires[key];
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

  /** @internal */
  serialize(now: number): StoredSession {
    this.keys(); // drops expired keys
    const expires = Object.keys(this.expires).length ? { ...this.expires } : undefined;
    return { data: { ...this.data }, meta: { v: 1, savedAt: now, expires } };
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
    },
  };
}
