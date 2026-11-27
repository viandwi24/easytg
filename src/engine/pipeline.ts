// The update pipeline behind `bot.use(app)`: per-user ordering and locks, the
// rate limit, then the handlers, and saving state once at the end.
import type { Context, MiddlewareFn } from 'grammy';
import { SpamGuard, type AntiSpamOptions } from '../antispam';
import { decodeInline, decodeStoredToken } from '../callback';
import { Locks, type AtomicStorage, type Release } from '../coordination';
import { isCommand } from '../dialogue';
import type { EasyTG } from '../engine';
import { UPDATES_KEY, flows, userKey } from './scope';
import type { UpdateOutcome } from './types';

/** @internal */
export class Pipeline<C extends Context> {
  readonly spamGuard: SpamGuard;
  private readonly antiSpam: AntiSpamOptions<C> | undefined;
  private readonly locks: Locks;
  /** Updates being handled in this process, by `userKey`. */
  private readonly liveUpdates = new Map<string, C>();
  private readonly sequentialTimeoutMs?: number;
  private readonly dedupe: boolean;
  private readonly waitWhileBusy: boolean;

  constructor(
    private readonly app: EasyTG<C>,
    /** Rate limits, double taps and locks: in memory, or shared with `cluster`. */
    coordination: AtomicStorage,
    /** Set with `cluster`: locks are shared between processes. */
    shared: AtomicStorage | undefined,
    options: {
      antiSpam?: AntiSpamOptions<C> | false;
      sequential?: boolean | { timeoutMs?: number };
      dedupeUpdates?: boolean;
      buttons?: { whileBusy?: 'drop' | 'wait' };
    },
  ) {
    this.dedupe = options.dedupeUpdates ?? false;
    this.waitWhileBusy = options.buttons?.whileBusy === 'wait';
    this.locks = new Locks(shared);
    const sequential = options.sequential ?? true;
    if (sequential) this.sequentialTimeoutMs = (sequential === true ? undefined : sequential.timeoutMs) ?? DEFAULT_WAIT_MS;
    const antiSpam = options.antiSpam === false ? undefined : options.antiSpam ?? {};
    this.antiSpam = antiSpam && { warn: true, ...antiSpam };
    this.spamGuard = new SpamGuard(coordination, antiSpam?.limit ?? 20, antiSpam?.windowMs ?? 10_000, antiSpam?.cooldownMs ?? 30_000);
  }

  middleware(): MiddlewareFn<C> {
    return async (ctx, next) => {
      const started = Date.now();
      let outcome: UpdateOutcome = 'error'; // unless run() returns
      try {
        outcome = await flows.run({ key: userKey(ctx), ctx, queues: new Set() }, () => this.run(ctx, next));
      } finally {
        if (this.app.hasListeners('update')) {
          await this.app.emit('update', { ctx, durationMs: Date.now() - started, outcome });
        }
      }
    };
  }

  /** The update of this user being handled in this process right now, if any. */
  liveUpdate(key: string): C | undefined {
    return this.liveUpdates.get(key);
  }

  /** The user's lock for a proactive render; null when updates aren't sequential (or it waited too long). */
  lockUser(key: string): Promise<Release | null> | null {
    return this.sequentialTimeoutMs === undefined ? null : this.locks.acquire(key, this.sequentialTimeoutMs);
  }

  /** The update pipeline. Returns how the update ended, for the `update` event. */
  private async run(ctx: C, next: () => Promise<void>): Promise<UpdateOutcome> {
    // The lock is requested before anything is awaited, so a user's updates keep
    // their order; the rate limit is checked meanwhile, so waiting doesn't delay it.
    const abort = new AbortController();
    const locking = this.lockUpdate(ctx, abort.signal);
    const unlock = async () => {
      abort.abort(); // stop waiting for the lock
      const release = await locking;
      if (typeof release === 'function') await release();
    };
    let passes: boolean;
    try {
      passes = await this.passesSpamCheck(ctx);
    } catch (error) {
      await unlock();
      throw error;
    }
    if (!passes) {
      await unlock();
      return 'limited';
    }
    const release = await locking;
    if (release === 'busy') {
      await this.app.delivery.answerCallback(ctx, { text: this.app.textsFor(ctx).busy });
      return 'busy';
    }
    let passedOn = false;
    let duplicate = false;
    try {
      duplicate = !(await this.handleUpdate(ctx, async () => {
        passedOn = true;
        await next();
      }));
    } finally {
      await this.app.queues.releaseHeld(ctx);
      await release?.();
    }
    return duplicate ? 'duplicate' : passedOn ? 'next' : 'easytg';
  }

  /** False when the update was skipped: handled before (`dedupeUpdates`). */
  private async handleUpdate(ctx: C, next: () => Promise<void>): Promise<boolean> {
    this.app.scopes.get(ctx).inUpdate = true;
    const live = userKey(ctx);
    if (live !== undefined) this.liveUpdates.set(live, ctx);
    let failed = false;
    try {
      if (this.dedupe && (await this.seenBefore(ctx))) {
        this.app.logger.debug(`Skipped update ${ctx.update.update_id}: handled before`);
        if (ctx.callbackQuery) await this.app.delivery.answerCallback(ctx);
        return false;
      }
      await this.app.runBefore(ctx, () => this.app.handlers.handle(ctx, next));
      return true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Sessions and stored buttons changed anywhere in this update are saved once, here.
      try {
        await this.app.flush(ctx);
      } catch (error) {
        if (!failed) throw error;
        this.app.logger.error('Failed to save state', error);
      } finally {
        if (live !== undefined && this.liveUpdates.get(live) === ctx) this.liveUpdates.delete(live);
      }
    }
  }

  /**
   * Whether this update was handled before; if not, it is recorded in the
   * session, saved at the end of the update with everything else. Ids, not
   * "the last id": Telegram may start counting anew after a week of silence.
   */
  private async seenBefore(ctx: C): Promise<boolean> {
    if (!ctx.chat || !ctx.from || (!ctx.message && !ctx.callbackQuery)) return false;
    const session = await this.app.sessions.state(ctx);
    const id = ctx.update.update_id;
    const seen = session.get<number[]>(UPDATES_KEY);
    const ids = Array.isArray(seen) ? seen : [];
    if (ids.includes(id)) return true;
    session.set(UPDATES_KEY, [...ids, id].slice(-RECENT_UPDATES));
    return false;
  }

  /**
   * The per-user lock of an update: undefined = no lock needed (or waited too
   * long), 'busy' = a button pressed while the user's previous update runs.
   */
  private async lockUpdate(ctx: C, signal: AbortSignal): Promise<Release | undefined | 'busy'> {
    const userId = ctx.from?.id;
    if (userId === undefined || (!ctx.message && !ctx.callbackQuery)) return undefined;
    const key = userKey(ctx)!;
    const data = ctx.callbackQuery?.data;
    const press = data !== undefined && !!(decodeStoredToken(data) || decodeInline(data));
    if (press && !this.waitWhileBusy) {
      // One button press per user at a time: a press while busy is answered, not queued.
      return (await this.locks.tryAcquire(key)) ?? 'busy';
    }
    // Presses wait even with `sequential: false` (they always took the lock).
    const timeoutMs = this.sequentialTimeoutMs ?? (press ? DEFAULT_WAIT_MS : undefined);
    if (timeoutMs === undefined) return undefined;
    const release = await this.locks.acquire(key, timeoutMs, signal);
    if (!release && !signal.aborted) this.app.logger.debug(`Update of user ${userId} waited ${timeoutMs} ms for the previous one; handling it anyway`);
    return release ?? undefined;
  }

  /** False when the update must be dropped: the user is limited. */
  private async passesSpamCheck(ctx: C): Promise<boolean> {
    const app = this.app;
    const userId = ctx.from?.id;
    if (userId === undefined) return true;
    // Payments always go through, even from limited users: the money is already moving.
    if (ctx.preCheckoutQuery || ctx.message?.successful_payment) return true;
    const config = this.antiSpam;
    // Only user interactions count towards the limit (and `exempt` users never
    // count), but a limited user's updates are all dropped.
    const counts = !!config && (config.filter ? config.filter(ctx) : isInteraction(ctx)) && !config.exempt?.(ctx);

    // Counted per bot, so one instance can serve several bots; manual limits may cover all of them.
    const botId = ctx.me.id;
    const verdict = await this.spamGuard.check(botId, userId, counts);
    if (verdict.status === 'ok') return true;

    let silenced = false;
    if (verdict.status === 'limited') {
      app.logger.warn(`User ${userId} exceeded the rate limit (strike ${verdict.strike})`);
      await app.emit('spam', {
        ctx,
        userId,
        chatId: ctx.chat?.id,
        count: verdict.count,
        windowMs: this.spamGuard.windowMs,
        strike: verdict.strike,
        until: verdict.until,
        silence: () => void (silenced = true),
      });
      // A listener may have released the user.
      if (!(await app.isLimited(userId, botId))) return true;
    }

    const warn = verdict.status === 'limited' && config?.warn && !silenced;
    const seconds = Math.ceil(((verdict as { until?: number }).until ?? Date.now()) - Date.now()) / 1000;
    const text = warn ? app.textsFor(ctx).spam(Math.max(1, Math.ceil(seconds))) : undefined;
    if (ctx.callbackQuery) {
      await app.delivery.answerCallback(ctx, text ? { text, show_alert: true } : undefined);
    } else if (text && ctx.chat?.type === 'private') {
      try {
        await ctx.reply(text);
      } catch (error) {
        app.logger.debug('Failed to send spam warning', error);
      }
    }
    return false;
  }
}

/** How long an update waits for the user's previous one by default. */
const DEFAULT_WAIT_MS = 8_000;

/** How many update ids `dedupeUpdates` remembers per user and chat. */
const RECENT_UPDATES = 20;

/** Default anti-spam scope: button presses, and messages with content in private chats or /commands in groups. */
function isInteraction(ctx: Context): boolean {
  if (ctx.callbackQuery) return true;
  const message = ctx.message;
  if (!message) return false;
  const content =
    message.text !== undefined ||
    !!(message.photo || message.video || message.animation || message.document || message.audio || message.voice || message.video_note || message.sticker);
  if (!content) return false;
  return message.chat.type === 'private' || isCommand(message);
}
