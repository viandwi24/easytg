import { sha256, toBase64Url } from './platform/crypto';
import type { StorageAdapter } from './storage';

/**
 * Where button params live:
 * - `inline` — in the callback data (max 64 bytes, readable and forgeable).
 * - `auto`   — inline when it fits, stored server-side otherwise. Default.
 * - `stored` — always server-side when there are params; inline params from
 *              clients are rejected, so params can't be forged.
 * - `signed` — inline plus a short HMAC (needs `buttons.secret`): can't be
 *              forged either, and nothing is written to storage.
 */
export type CallbackParamsMode = 'inline' | 'auto' | 'stored' | 'signed';

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
    private ttlMs: number,
    private keyPrefix = 'cb:',
  ) {}

  private key(token: string, scope: string) {
    return scope ? `${this.keyPrefix}${scope}:${token}` : this.keyPrefix + token;
  }

  tokenFor(entry: StoredCallback, chatId?: number): string {
    const params = Object.keys(entry.q).sort().map((k) => [k, entry.q[k]]);
    const material = JSON.stringify([entry.p, params, entry.u ?? null, chatId ?? null]);
    return toBase64Url(sha256(material)).slice(0, 16); // 96 bits
  }

  /** `scope` namespaces keys, e.g. per bot. */
  write(token: string, entry: StoredCallback, scope = '') {
    return this.storage.set(this.key(token, scope), entry, this.ttlMs);
  }

  async resolve(token: string, userId: number | undefined, scope = ''): Promise<ResolvedCallback> {
    const entry = (await this.storage.get(this.key(token, scope))) as StoredCallback | null | undefined;
    if (!entry || typeof entry.p !== 'string' || typeof entry.q !== 'object') return { status: 'expired' };
    if (entry.u !== undefined && entry.u !== userId) return { status: 'forbidden' };
    return { status: 'ok', id: entry.p, params: { ...entry.q } };
  }
}
