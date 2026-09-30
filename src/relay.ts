/**
 * Relays: two users talk through the bot. What one sends in their private
 * chat with the bot is copied to the other, so neither sees the other's
 * account. Anonymous chats, support desks, buyer–seller chats.
 */
import type { Api, Context } from 'grammy';
import type { StorageAdapter } from './storage';

export interface RelayLink {
  /** The other user. */
  peer: number;
  /** When the relay started (ms since epoch). */
  since: number;
  /** What you passed to `start` (JSON). */
  data?: unknown;
}

export interface RelayStartOptions {
  /** End the relay by itself after this long (both sides). Default: until `end`. */
  ttlMs?: number;
  /** Anything JSON you want back from `peer()`, e.g. a conversation id. */
  data?: unknown;
}

/** Why a relay ended. */
export type RelayEndReason = 'app' | 'unreachable';

/** Something that knows its bot: a context, or a bot (after `bot.init()`). */
export type RelayBot = Context | { botInfo: { id: number }; api?: Api };

export function relayBotId(bot: RelayBot): number {
  return 'me' in bot && bot.me ? bot.me.id : (bot as { botInfo: { id: number } }).botInfo.id;
}

export class RelayStore {
  constructor(private readonly storage: StorageAdapter) {}

  private key(botId: number, userId: number) {
    return `relay:${botId}:${userId}`;
  }

  async get(botId: number, userId: number): Promise<RelayLink | undefined> {
    const link = (await this.storage.get(this.key(botId, userId))) as RelayLink | null | undefined;
    return link ?? undefined;
  }

  async start(botId: number, a: number, b: number, options: RelayStartOptions): Promise<{ ended: [number, number][] }> {
    if (a === b) throw new Error('A relay needs two different users');
    // Anyone already in a relay leaves it first.
    const ended: [number, number][] = [];
    for (const user of [a, b]) {
      const previous = await this.end(botId, user);
      if (previous) ended.push([user, previous.peer]);
    }
    const since = Date.now();
    await this.storage.set(this.key(botId, a), { peer: b, since, data: options.data } satisfies RelayLink, options.ttlMs);
    await this.storage.set(this.key(botId, b), { peer: a, since, data: options.data } satisfies RelayLink, options.ttlMs);
    return { ended };
  }

  /** Ends the user's relay (both sides). Returns the link that ended, if any. */
  async end(botId: number, userId: number): Promise<RelayLink | undefined> {
    const link = await this.get(botId, userId);
    if (!link) return undefined;
    await this.storage.delete(this.key(botId, userId));
    const back = await this.get(botId, link.peer);
    if (back?.peer === userId) await this.storage.delete(this.key(botId, link.peer));
    return link;
  }
}
