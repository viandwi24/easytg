import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signatures for `buttons.params: 'signed'`: params stay in the callback data,
 * plus a short HMAC so they can't be forged. No storage writes.
 *
 * The signature covers the bot, the chat, the target, the params and, for
 * buttons bound to a user, that user. It is carried as `_s=<flag><mac>`,
 * where the flag says whether a user is bound (`u`) or not (`a`).
 */
const MAC_LENGTH = 11; // base64url chars ≈ 66 bits

export interface SignScope {
  botId: number;
  chatId?: number;
  /** Bound user, or undefined for buttons anyone allowed may press. */
  userId?: number;
}

function mac(secret: string, scope: SignScope, id: string, params: Record<string, string>) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, params[key]]);
  const material = JSON.stringify([scope.botId, scope.chatId ?? null, scope.userId ?? null, id, sorted]);
  return createHmac('sha256', secret).update(material).digest('base64url').slice(0, MAC_LENGTH);
}

export function sign(secret: string, scope: SignScope, id: string, params: Record<string, string>): string {
  return (scope.userId === undefined ? 'a' : 'u') + mac(secret, scope, id, params);
}

/** Checks `signature` for `params` (without `_s`), pressed by `pressedBy`. */
export function verify(
  secret: string,
  scope: Omit<SignScope, 'userId'>,
  pressedBy: number | undefined,
  id: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature || signature.length !== MAC_LENGTH + 1) return false;
  const bound = signature[0] === 'u';
  if (!bound && signature[0] !== 'a') return false;
  const expected = mac(secret, { ...scope, userId: bound ? pressedBy : undefined }, id, params);
  const a = Buffer.from(signature.slice(1));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
