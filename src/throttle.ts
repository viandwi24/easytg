import type { Transformer } from 'grammy';
import type { AtomicStorage } from './coordination';

/** At most `limit` API calls per `perMs`. */
export interface ThrottleRule {
  limit: number;
  perMs: number;
}

export interface ThrottleOptions {
  /** All calls of the bot. Default 30 per second (Telegram's limit for bulk sending). `false`: none. */
  global?: ThrottleRule | false;
  /** Per group, supergroup or channel. Default 20 per minute (Telegram's limit). `false`: none. */
  groupChat?: ThrottleRule | false;
  /**
   * Per private chat. Default: none (a page split into several messages goes
   * out at once). Telegram advises about 1 per second over time.
   */
  privateChat?: ThrottleRule | false;
  /**
   * Your own rule for particular chats, e.g. a busy channel or a VIP group:
   * return a rule (replaces the private/group one), `false` (no limit for
   * that chat) or `undefined` (the defaults).
   */
  chat?: (chatId: number | string) => ThrottleRule | false | undefined;
  /** Which API methods are limited. Default: sending, copying, forwarding and editing messages. */
  methods?: (method: string) => boolean;
  /** Longest a call waits for a slot; then it goes out anyway. Default 60 000. */
  maxWaitMs?: number;
  /**
   * Name of the counters. Several bots sharing one storage (with `cluster`)
   * need one each, e.g. the bot's username. Default `bot`.
   */
  id?: string;
}

const LIMITED = /^(send(?!ChatAction)|copyMessage|forwardMessage|editMessage)/;

/** grammY's AbortSignal type (from its own polyfill), as far as we need it. */
interface Signal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

const sleep = (ms: number, signal?: Signal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * An API transformer that spaces outgoing messages to stay within Telegram's
 * limits, instead of hitting 429s. Counters live in `storage`, so with a
 * shared storage every process of the bot counts together.
 */
export function createThrottle(storage: AtomicStorage, options: ThrottleOptions = {}): Transformer {
  const global = options.global === undefined ? { limit: 30, perMs: 1000 } : options.global;
  const group = options.groupChat === undefined ? { limit: 20, perMs: 60_000 } : options.groupChat;
  const privateChat = options.privateChat ?? false;
  const limited = options.methods ?? ((method: string) => LIMITED.test(method));
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const id = options.id ?? 'bot';

  /** Take one slot of `rule` (counted `cost` times), waiting for the next window when it is full. */
  const take = async (name: string, rule: ThrottleRule, cost: number, deadline: number, signal?: Signal) => {
    for (;;) {
      const window = Math.floor(Date.now() / rule.perMs);
      // An album bigger than the limit still fits in an empty window, instead of waiting forever.
      const count = await storage.increment(`throttle:${id}:${name}:${window}`, Math.min(cost, rule.limit), rule.perMs * 2);
      if (count <= rule.limit || Date.now() >= deadline || signal?.aborted) return;
      const wait = (window + 1) * rule.perMs - Date.now() + Math.random() * 20; // a little jitter
      await sleep(Math.min(wait, deadline - Date.now()), signal);
    }
  };

  return async (prev, method, payload, signal) => {
    if (!limited(method)) return prev(method, payload, signal);
    const p = payload as { chat_id?: number | string; media?: unknown[] };
    // An album counts as one message per item.
    const cost = method === 'sendMediaGroup' && Array.isArray(p.media) ? p.media.length : 1;
    const deadline = Date.now() + maxWaitMs;
    const chatId = p.chat_id;
    if (chatId !== undefined) {
      const own = options.chat?.(chatId);
      const rule = own !== undefined ? own : typeof chatId === 'number' && chatId > 0 ? privateChat : group;
      if (rule) await take(`chat:${chatId}`, rule, cost, deadline, signal);
    }
    if (global) await take('global', global, cost, deadline, signal);
    return prev(method, payload, signal);
  };
}
