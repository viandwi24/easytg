import type { Context } from 'grammy';
import type { AtomicStorage } from './coordination';

export interface AntiSpamOptions<C extends Context = Context> {
  /** Updates (messages, button presses, …) a user may send per window. Default 20. */
  limit?: number;
  /** Window length in ms. Default 10 000. */
  windowMs?: number;
  /** How long a user is ignored after exceeding the limit, in ms. Default 30 000. */
  cooldownMs?: number;
  /** Tell the user they were limited: a toast on buttons, a reply in private chats. Default true. */
  warn?: boolean;
  /** Users that are never limited, e.g. admins. */
  exempt?: (ctx: C) => boolean;
  /**
   * Which updates count towards the limit. Default: button presses, plus
   * messages with content in private chats and /commands in groups. While a
   * user is limited, all their updates are dropped, except payments.
   */
  filter?: (ctx: C) => boolean;
}

export interface SpamEvent<C extends Context = Context> {
  ctx: C;
  userId: number;
  chatId?: number;
  /** Updates counted in the window when the limit was hit. */
  count: number;
  windowMs: number;
  /** How many times this user has been limited recently (resets after 24h without incidents). */
  strike: number;
  /** When the cooldown ends (ms timestamp). */
  until: number;
  /** Don't send the default warning for this incident (e.g. because you banned the user). */
  silence(): void;
}

export type SpamVerdict =
  | { status: 'ok' }
  | { status: 'blocked'; until: number }
  | { status: 'limited'; until: number; count: number; strike: number };

const STRIKE_RESET_MS = 24 * 60 * 60 * 1000;

/** Limits of one user: `'*'` (every bot) or a bot id → until (ms). */
type Blocks = Record<string, number>;

/**
 * Rate limit per bot and user: a fixed window counted in storage, so it is
 * shared by every process when the storage is. Keys: `spam:hits:<bot>:<user>`,
 * `spam:block:<user>`, `spam:strikes:<bot>:<user>`.
 */
export class SpamGuard {
  constructor(
    private readonly storage: AtomicStorage,
    readonly limit: number,
    readonly windowMs: number,
    readonly cooldownMs: number,
  ) {}

  /** Count an update; `count: false` only checks the limits. */
  async check(bot: number, user: number, count = true, now = Date.now()): Promise<SpamVerdict> {
    const blocks = await this.blocks(user);
    const until = Math.max(blocks['*'] ?? 0, blocks[bot] ?? 0);
    if (until > now) return { status: 'blocked', until };
    if (!count) return { status: 'ok' };

    const hitsKey = `spam:hits:${bot}:${user}`;
    const hits = await this.storage.increment(hitsKey, 1, this.windowMs);
    if (hits <= this.limit) return { status: 'ok' };
    // Concurrent updates past the limit: only the first one applies it (one event, one strike).
    if (hits > this.limit + 1) return { status: 'blocked', until: now + this.cooldownMs };

    await this.storage.delete(hitsKey);
    const blockedUntil = now + this.cooldownMs;
    await this.block(user, String(bot), this.cooldownMs, now);
    const strikesKey = `spam:strikes:${bot}:${user}`;
    const strike = (Number(await this.storage.get(strikesKey)) || 0) + 1;
    await this.storage.set(strikesKey, strike, STRIKE_RESET_MS);
    return { status: 'limited', until: blockedUntil, count: hits, strike };
  }

  /** Limit a user on one bot, or on every bot (`'*'`). */
  async block(user: number, bot: string, ms: number, now = Date.now()) {
    const blocks = await this.blocks(user, now);
    blocks[bot] = Math.max(blocks[bot] ?? 0, now + ms);
    await this.save(user, blocks, now);
  }

  /** Lift a user's limits: on one bot (and the every-bot limit), or all of them. */
  async release(user: number, bot?: number) {
    if (bot === undefined) {
      await this.storage.delete(`spam:block:${user}`);
      return;
    }
    const blocks = await this.blocks(user);
    delete blocks['*'];
    delete blocks[bot];
    await Promise.all([this.save(user, blocks), this.storage.delete(`spam:hits:${bot}:${user}`)]);
  }

  async isBlocked(user: number, bot?: number, now = Date.now()) {
    const blocks = await this.blocks(user, now);
    if (bot === undefined) return Object.keys(blocks).length > 0;
    return (blocks['*'] ?? 0) > now || (blocks[bot] ?? 0) > now;
  }

  /** Active limits only. */
  private async blocks(user: number, now = Date.now()): Promise<Blocks> {
    const stored = await this.storage.get(`spam:block:${user}`);
    const blocks: Blocks = {};
    if (stored && typeof stored === 'object') {
      for (const [bot, until] of Object.entries(stored)) if (typeof until === 'number' && until > now) blocks[bot] = until;
    }
    return blocks;
  }

  private async save(user: number, blocks: Blocks, now = Date.now()) {
    const key = `spam:block:${user}`;
    const last = Math.max(0, ...Object.values(blocks));
    if (last <= now) await this.storage.delete(key);
    else await this.storage.set(key, blocks, last - now);
  }
}
