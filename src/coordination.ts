import { EasyTGError } from './errors';
import type { StorageAdapter } from './storage';

/** Storage with the atomic operations rate limits and locks need. */
export type AtomicStorage = StorageAdapter & Required<Pick<StorageAdapter, 'increment' | 'setIfAbsent'>>;

export function assertAtomic(storage: StorageAdapter, what: string): asserts storage is AtomicStorage {
  if (typeof storage.increment !== 'function' || typeof storage.setIfAbsent !== 'function') {
    throw new EasyTGError(`${what} needs a storage with increment() and setIfAbsent() (e.g. RedisStorage, SqliteStorage)`);
  }
}

export type Release = () => Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * A key held in shared storage with a TTL, refreshed while held so a crashed
 * process can't keep it forever. Returns undefined if the key is taken.
 */
async function holdShared(storage: AtomicStorage, key: string, ttlMs: number): Promise<Release | undefined> {
  const id = token();
  if (!(await storage.setIfAbsent(key, id, ttlMs))) return undefined;
  const timer = setInterval(async () => {
    try {
      // Only refresh our own hold (it may have expired and been taken by another process).
      if ((await storage.get(key)) === id) await storage.set(key, id, ttlMs);
    } catch {}
  }, ttlMs / 2);
  (timer as { unref?: () => void }).unref?.();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      if ((await storage.get(key)) === id) await storage.delete(key);
    } catch {} // it expires on its own
  };
}

/**
 * Mutual exclusion by key. Waiters in this process queue in order (a waiter's
 * place is taken synchronously, when `acquire` is called); with a shared
 * storage, the lock is also held in storage.
 */
export class Locks {
  private readonly held = new Map<string, Array<() => void>>();

  constructor(
    /** Shared storage, or undefined for per-process locks. */
    private readonly shared: AtomicStorage | undefined,
    private readonly ttlMs = 30_000,
  ) {}

  /** Take the lock if it's free; null if it's held. */
  async tryAcquire(key: string): Promise<Release | null> {
    if (this.held.has(key)) return null;
    this.held.set(key, []);
    try {
      const shared = this.shared ? await holdShared(this.shared, `lock:${key}`, this.ttlMs) : undefined;
      if (this.shared && !shared) {
        this.releaseLocal(key);
        return null;
      }
      return this.releaser(key, shared);
    } catch (error) {
      this.releaseLocal(key);
      throw error;
    }
  }

  /** Wait for the lock, at most `timeoutMs`; null on timeout or when `signal` aborts. */
  async acquire(key: string, timeoutMs: number, signal?: AbortSignal): Promise<Release | null> {
    const deadline = Date.now() + timeoutMs;
    if (!(await this.acquireLocal(key, timeoutMs, signal))) return null;
    if (!this.shared) return this.releaser(key, undefined);
    let delay = 20;
    try {
      for (;;) {
        const shared = await holdShared(this.shared, `lock:${key}`, this.ttlMs);
        if (shared) return this.releaser(key, shared);
        if (signal?.aborted || Date.now() + delay > deadline) {
          this.releaseLocal(key);
          return null;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 250);
      }
    } catch (error) {
      this.releaseLocal(key);
      throw error;
    }
  }

  private acquireLocal(key: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const waiters = this.held.get(key);
    if (!waiters) {
      this.held.set(key, []);
      return Promise.resolve(true);
    }
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const giveUp = () => {
        const index = waiters.indexOf(wake);
        if (index < 0) return; // already woken: it owns the lock now
        waiters.splice(index, 1);
        clearTimeout(timer);
        resolve(false);
      };
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', giveUp);
        resolve(true);
      };
      const timer = setTimeout(giveUp, timeoutMs);
      signal?.addEventListener('abort', giveUp, { once: true });
      waiters.push(wake);
    });
  }

  private releaseLocal(key: string) {
    const next = this.held.get(key)?.shift();
    if (next) next(); // hand the lock straight to the next waiter
    else this.held.delete(key);
  }

  private releaser(key: string, shared: Release | undefined): Release {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await shared?.();
      } finally {
        this.releaseLocal(key);
      }
    };
  }
}

export interface QueueOptions {
  /** Jobs running at the same time (across processes with `cluster`). */
  concurrency: number;
  /** Jobs allowed to wait (per process); more are rejected with `QueueFullError`. Default: unlimited. */
  maxWaiting?: number;
  /** Running or waiting jobs per user (needs `ctx`); more are rejected with `QueueFullError`. Default: unlimited. */
  perUser?: number;
  /** Give up waiting after this many ms with `QueueTimeoutError`. Default: wait forever. */
  timeoutMs?: number;
}

/** Thrown by `app.queue` / `app.enterQueue` when a job can't wait (`maxWaiting`, `perUser`). */
export class QueueFullError extends EasyTGError {
  constructor(
    readonly queue: string,
    readonly reason: 'maxWaiting' | 'perUser',
  ) {
    super(`Queue "${queue}" is full (${reason})`);
    this.name = 'QueueFullError';
  }
}

/** Thrown by `app.queue` / `app.enterQueue` when a job waited longer than `timeoutMs`. */
export class QueueTimeoutError extends EasyTGError {
  constructor(readonly queue: string) {
    super(`Timed out waiting in queue "${queue}"`);
    this.name = 'QueueTimeoutError';
  }
}

type OnWait = (position: number | undefined) => unknown;

/**
 * A concurrency limit (semaphore). In one process, waiters are served in
 * order. With a shared storage, running jobs (and, for `perUser`, a user's
 * jobs) hold numbered slots in storage, refreshed while held; waiters poll
 * for a free one.
 */
export class Queue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly perUserCount = new Map<number, number>();

  constructor(
    readonly name: string,
    private readonly options: QueueOptions,
    private readonly shared: AtomicStorage | undefined,
    private readonly slotTtlMs = 60_000,
  ) {
    if (!(options.concurrency >= 1)) throw new EasyTGError(`Queue "${name}": concurrency must be at least 1`);
  }

  /** Jobs waiting in this process. */
  get size() {
    return this.waiting.length;
  }

  /**
   * Wait for a slot. `onWait` is called once if the job has to wait, with its
   * position (1 = next; undefined with a shared queue, where it isn't known).
   */
  async acquire(user: number | undefined, onWait?: OnWait): Promise<Release> {
    const { perUser, maxWaiting, timeoutMs } = this.options;
    const limitUser = user !== undefined && perUser !== undefined;
    if (limitUser && (this.perUserCount.get(user) ?? 0) >= perUser) throw new QueueFullError(this.name, 'perUser');
    if (maxWaiting !== undefined && this.isBusy() && this.waiting.length >= maxWaiting) {
      throw new QueueFullError(this.name, 'maxWaiting');
    }

    // Everything taken so far, undone in reverse order on failure or release.
    const undo: Release[] = [];
    const rollback = async () => {
      for (const release of undo.splice(0).reverse()) await release();
    };
    try {
      if (limitUser) {
        this.countUser(user, 1);
        undo.push(async () => this.countUser(user, -1));
        if (this.shared) {
          const slot = await this.claimShared(`queue:${this.name}:user:${user}`, perUser, 0);
          if (!slot) throw new QueueFullError(this.name, 'perUser');
          undo.push(slot);
        }
      }

      const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
      if (this.isBusy()) {
        const position = this.waiting.length + 1;
        const waited = this.waitLocal(deadline);
        await notify(onWait, this.shared ? undefined : position);
        onWait = undefined;
        if (!(await waited)) throw new QueueTimeoutError(this.name);
      } else {
        this.running++;
      }
      undo.push(async () => this.next());

      if (this.shared) {
        const slot = await this.claimShared(`queue:${this.name}:slot`, this.options.concurrency, deadline, onWait);
        if (!slot) throw new QueueTimeoutError(this.name);
        undo.push(slot);
      }
    } catch (error) {
      await rollback();
      throw error;
    }
    return rollback;
  }

  private isBusy() {
    return this.running >= this.options.concurrency || this.waiting.length > 0;
  }

  /** Resolves true when woken with the local slot, false on timeout. */
  private waitLocal(deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer =
        deadline === Infinity
          ? undefined
          : setTimeout(() => {
              const index = this.waiting.indexOf(wake);
              if (index < 0) return;
              this.waiting.splice(index, 1);
              resolve(false);
            }, deadline - Date.now());
      this.waiting.push(wake);
    });
  }

  /** Hand the local slot to the next waiter, or free it. */
  private next() {
    const wake = this.waiting.shift();
    if (wake) wake();
    else this.running--;
  }

  private countUser(user: number, by: number) {
    const count = (this.perUserCount.get(user) ?? 0) + by;
    if (count > 0) this.perUserCount.set(user, count);
    else this.perUserCount.delete(user);
  }

  /** One of `count` numbered keys in storage, polling until `deadline` (0 = try once). */
  private async claimShared(prefix: string, count: number, deadline: number, onWait?: OnWait) {
    let delay = 50;
    for (;;) {
      for (let i = 0; i < count; i++) {
        const release = await holdShared(this.shared!, `${prefix}:${i}`, this.slotTtlMs);
        if (release) return release;
      }
      if (Date.now() + delay > deadline) return undefined;
      await notify(onWait, undefined);
      onWait = undefined;
      await sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

/** `onWait` only informs; its errors must not break the queue. */
async function notify(onWait: OnWait | undefined, position: number | undefined) {
  try {
    await onWait?.(position);
  } catch {}
}
