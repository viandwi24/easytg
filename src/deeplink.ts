import { Buffer } from 'node:buffer';
import { decodeInline, encodeInline } from './callback';

/**
 * `/start <payload>` deep links (t.me/<bot>?start=<payload>). A payload is at
 * most 64 characters of `A-Z a-z 0-9 _ -`. Formats:
 *
 *   <pageId>        page or dialogue without params (readable: ?start=signup)
 *   _i<base64url>   id + params inline
 *   _s<token>       id + params stored server-side
 *
 * Page ids can't start with `_`, so the formats never collide. Only pages and
 * dialogues that call `.allowDeepLink()` can be opened this way: unlike button
 * data, a deep link can be typed by anyone.
 */
export const MAX_PAYLOAD = 64;
const PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;
const PLAIN_ID = /^[A-Za-z0-9-][A-Za-z0-9_-]*$/;

export type DecodedDeepLink =
  | { kind: 'inline'; id: string; params: Record<string, string> }
  | { kind: 'stored'; token: string };

/** Payload without server-side storage, or null if it doesn't fit. */
export function encodeDeepLinkInline(id: string, params: Record<string, string>): string | null {
  if (Object.keys(params).length === 0 && PLAIN_ID.test(id) && id.length <= MAX_PAYLOAD) return id;
  const packed = encodeInline(id, params).slice(2); // drop the "p|" prefix
  const payload = `_i${Buffer.from(packed, 'utf8').toString('base64url')}`;
  return payload.length <= MAX_PAYLOAD ? payload : null;
}

export function encodeDeepLinkStored(token: string) {
  return `_s${token}`;
}

export function decodeDeepLink(payload: string): DecodedDeepLink | null {
  if (!PAYLOAD.test(payload)) return null;
  if (payload.startsWith('_s')) return { kind: 'stored', token: payload.slice(2) };
  if (payload.startsWith('_i')) {
    const decoded = decodeInline(`p|${Buffer.from(payload.slice(2), 'base64url').toString('utf8')}`);
    return decoded ? { kind: 'inline', ...decoded } : null;
  }
  if (payload.startsWith('_')) return null;
  return { kind: 'inline', id: payload, params: {} };
}

/** The payload of a `/start <payload>` message for this bot, if any. */
export function startPayload(text: string | undefined, botUsername?: string): string | null {
  const match = /^\/start(?:@(\w+))?[ \t]+(\S+)\s*$/.exec(text ?? '');
  if (!match) return null;
  if (match[1] && botUsername && match[1].toLowerCase() !== botUsername.toLowerCase()) return null; // /start@other_bot
  return match[2]!;
}

export function deepLinkUrl(username: string, payload: string) {
  return `https://t.me/${username}?start=${payload}`;
}
