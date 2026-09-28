import type { Context } from 'grammy';

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
   * Which updates count towards the limit (and are dropped while a user is
   * limited). Default: button presses, plus messages with content in private
   * chats and /commands in groups. Payments, inline queries, member updates
   * and other service updates never count and are never dropped.
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

/**
 * Sliding-window rate limit, kept in memory (per process). Keys are
 * `<bot id>:<user id>`, or `*:<user id>` for limits that apply to every bot.
 */
export class SpamGuard {
  private readonly hits = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly strikes = new Map<string, { count: number; last: number }>();
  private checks = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly cooldownMs: number,
  ) {}

  check(key: string, now = Date.now()): SpamVerdict {
    if (++this.checks % 1000 === 0) this.sweep(now);

    const until = this.blockedUntil.get(key);
    if (until !== undefined) {
      if (until > now) return { status: 'blocked', until };
      this.blockedUntil.delete(key);
    }

    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    recent.push(now);
    if (recent.length <= this.limit) {
      this.hits.set(key, recent);
      return { status: 'ok' };
    }

    this.hits.delete(key);
    const blockedUntil = now + this.cooldownMs;
    this.blockedUntil.set(key, blockedUntil);
    const previous = this.strikes.get(key);
    const strike = previous && now - previous.last < STRIKE_RESET_MS ? previous.count + 1 : 1;
    this.strikes.set(key, { count: strike, last: now });
    return { status: 'limited', until: blockedUntil, count: recent.length, strike };
  }

  block(key: string, ms: number, now = Date.now()) {
    this.blockedUntil.set(key, now + ms);
  }

  /** Lift the limits of every key matching `match`. */
  release(match: (key: string) => boolean) {
    for (const map of [this.blockedUntil, this.hits]) {
      for (const key of map.keys()) if (match(key)) map.delete(key);
    }
  }

  isBlocked(key: string, now = Date.now()) {
    return (this.blockedUntil.get(key) ?? 0) > now;
  }

  /** Whether any key matching `match` is blocked. */
  isAnyBlocked(match: (key: string) => boolean, now = Date.now()) {
    for (const [key, until] of this.blockedUntil) if (until > now && match(key)) return true;
    return false;
  }

  private sweep(now: number) {
    for (const [user, times] of this.hits) if ((times.at(-1) ?? 0) <= now - this.windowMs) this.hits.delete(user);
    for (const [user, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(user);
    for (const [user, s] of this.strikes) if (now - s.last >= STRIKE_RESET_MS) this.strikes.delete(user);
  }
}
