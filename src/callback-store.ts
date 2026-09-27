import { createHash } from 'node:crypto';
import type { StorageAdapter } from './storage';

/**
 * Where button params live:
 * - `inline` — in the callback data (max 64 bytes, readable and forgeable).
 * - `auto`   — inline when it fits, stored server-side otherwise. Default.
 * - `stored` — always server-side when there are params; inline params from
 *              clients are rejected, so params can't be forged.
 */
export type CallbackParamsMode = 'inline' | 'auto' | 'stored';

export interface StoredCallback {
  /** target id (page or dialogue) */
  p: string;
  /** params */
  q: Record<string, string>;
  /** user the button was rendered for; only they can press it */
  u?: number;
}

export type ResolvedCallback =
  | { status: 'ok'; id: string; params: Record<string, string> }
  | { status: 'expired' }
  | { status: 'forbidden' };

/**
 * Tokens are derived from (target, params, user, chat): re-rendering the same
 * button reuses the entry and only refreshes its TTL. Security doesn't rely on
 * the token being secret — it only resolves if easytg stored it, and only for
 * the user it was rendered for.
 */
export class CallbackStore {
  constructor(
    private storage: StorageAdapter,
    private ttlSeconds: number,
    private keyPrefix = 'cb:',
  ) {}

  tokenFor(entry: StoredCallback, chatId?: number): string {
    const params = Object.keys(entry.q).sort().map((k) => [k, entry.q[k]]);
    const material = JSON.stringify([entry.p, params, entry.u ?? null, chatId ?? null]);
    return createHash('sha256').update(material).digest('base64url').slice(0, 16); // 96 bits
  }

  write(token: string, entry: StoredCallback) {
    return this.storage.set(this.keyPrefix + token, entry, this.ttlSeconds);
  }

  async resolve(token: string, userId: number | undefined): Promise<ResolvedCallback> {
    const entry = (await this.storage.get(this.keyPrefix + token)) as StoredCallback | null | undefined;
    if (!entry || typeof entry.p !== 'string' || typeof entry.q !== 'object') return { status: 'expired' };
    if (entry.u !== undefined && entry.u !== userId) return { status: 'forbidden' };
    return { status: 'ok', id: entry.p, params: { ...entry.q } };
  }
}
