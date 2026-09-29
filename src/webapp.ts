/**
 * Mini Apps (Web Apps): checking what a Mini App sends to your server, and
 * links that open one. See https://core.telegram.org/bots/webapps
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { Chat, User } from 'grammy/types';
import { EasyTGError } from './errors';

/** Telegram's Ed25519 keys for `signature` (third-party validation). */
const TELEGRAM_PUBLIC_KEYS = {
  production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
};

/** A user as a Mini App sees them. */
export interface WebAppUser extends Omit<User, 'is_bot'> {
  is_bot?: boolean;
  is_premium?: true;
  photo_url?: string;
  allows_write_to_pm?: true;
}

/** `initData`, checked and parsed. */
export interface WebAppInitData {
  /** Who opened the Mini App. */
  user?: WebAppUser;
  /** The chat partner (attachment menu in a private chat). */
  receiver?: WebAppUser;
  /** The chat it was opened in (attachment menu in groups and channels). */
  chat?: Pick<Chat, 'id' | 'type'> & { title?: string; username?: string; photo_url?: string };
  /** `sender`, `private`, `group`, `supergroup` or `channel` (opened from a direct link). */
  chatType?: string;
  chatInstance?: string;
  /** From `?startapp=…` / `startattach`. Untrusted like any link. */
  startParam?: string;
  /** For `answerWebAppQuery` (Mini Apps opened from an inline button or the menu button). */
  queryId?: string;
  /** Seconds after which the bot can message the user again. */
  canSendAfter?: number;
  authDate: Date;
  /** All fields as received. */
  raw: Record<string, string>;
}

export type WebAppAuthReason = 'malformed' | 'invalid' | 'expired';

/** `initData` that doesn't come from Telegram, or is too old. Answer the request with 401. */
export class WebAppAuthError extends EasyTGError {
  constructor(readonly reason: WebAppAuthReason) {
    super(`Invalid Mini App initData (${reason})`);
    this.name = 'WebAppAuthError';
  }
}

export interface VerifyInitDataOptions {
  /** Reject initData older than this. Default 24 hours; `Infinity` to accept any age. */
  maxAgeMs?: number;
}

function fields(initData: string | URLSearchParams): Record<string, string> {
  const params = typeof initData === 'string' ? new URLSearchParams(initData) : initData;
  return Object.fromEntries(params.entries());
}

/** `key=value` lines of the fields, sorted, without `skip`. */
function checkString(raw: Record<string, string>, skip: string[]) {
  return Object.keys(raw)
    .filter((key) => !skip.includes(key))
    .sort()
    .map((key) => `${key}=${raw[key]}`)
    .join('\n');
}

function parse(raw: Record<string, string>, maxAgeMs: number): WebAppInitData {
  const seconds = Number(raw.auth_date);
  if (!Number.isFinite(seconds)) throw new WebAppAuthError('malformed');
  if (maxAgeMs !== Infinity && Date.now() - seconds * 1000 > maxAgeMs) throw new WebAppAuthError('expired');
  const json = <T>(value: string | undefined): T | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new WebAppAuthError('malformed');
    }
  };
  return {
    user: json(raw.user),
    receiver: json(raw.receiver),
    chat: json(raw.chat),
    chatType: raw.chat_type,
    chatInstance: raw.chat_instance,
    startParam: raw.start_param,
    queryId: raw.query_id,
    canSendAfter: raw.can_send_after === undefined ? undefined : Number(raw.can_send_after),
    authDate: new Date(seconds * 1000),
    raw,
  };
}

/**
 * Check `initData` (what `Telegram.WebApp.initData` gives the Mini App; send
 * it with every request to your server) with your bot token, and parse it.
 * Throws `WebAppAuthError` when it is forged, malformed or too old. Never
 * trust a user id from a Mini App without this.
 *
 *   const { user } = verifyInitData(request.headers.get('x-init-data') ?? '', process.env.BOT_TOKEN!);
 */
export function verifyInitData(initData: string | URLSearchParams, botToken: string, options: VerifyInitDataOptions = {}): WebAppInitData {
  const raw = fields(initData);
  const hash = raw.hash;
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new WebAppAuthError('malformed');
  // secret_key = HMAC_SHA256(key: "WebAppData", message: bot_token)
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString(raw, ['hash'])).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new WebAppAuthError('invalid');
  return parse(raw, options.maxAgeMs ?? 24 * 60 * 60 * 1000);
}

/**
 * Check `initData` without the bot token, with Telegram's public key (for a
 * server that shouldn't hold the token). Needs the bot's id, the number
 * before `:` in its token.
 */
export function verifyInitDataSignature(
  initData: string | URLSearchParams,
  botId: number,
  options: VerifyInitDataOptions & { environment?: 'production' | 'test'; /** @internal */ publicKey?: string } = {},
): WebAppInitData {
  const raw = fields(initData);
  const signature = raw.signature;
  if (!signature) throw new WebAppAuthError('malformed');
  const keyHex = options.publicKey ?? TELEGRAM_PUBLIC_KEYS[options.environment ?? 'production'];
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keyHex, 'hex').toString('base64url') }, format: 'jwk' });
  const message = `${botId}:WebAppData\n${checkString(raw, ['hash', 'signature'])}`;
  let valid = false;
  try {
    valid = verifySignature(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
  } catch {
    throw new WebAppAuthError('malformed');
  }
  if (!valid) throw new WebAppAuthError('invalid');
  return parse(raw, options.maxAgeMs ?? 24 * 60 * 60 * 1000);
}

export interface MiniAppLinkOptions {
  /** The Mini App's short name (from @BotFather). Without it: the bot's main Mini App. */
  app?: string;
  /** Passed to the Mini App as `start_param`: letters, digits, `_` and `-`, up to 512 characters. */
  startParam?: string;
  /** `compact` (half screen) or `fullscreen`. Default: Telegram's choice. */
  mode?: 'compact' | 'fullscreen';
}

/**
 * A `t.me` link that opens a Mini App, e.g. to share or to use in `nav.url`:
 * `miniAppLink('shop_bot', { app: 'store', startParam: 'item_42' })`.
 */
export function miniAppLink(botUsername: string, options: MiniAppLinkOptions = {}): string {
  const { app, startParam, mode } = options;
  if (startParam !== undefined && !/^[A-Za-z0-9_-]{0,512}$/.test(startParam)) {
    throw new EasyTGError('miniAppLink: startParam may only contain letters, digits, _ and - (up to 512)');
  }
  const query = new URLSearchParams();
  query.set('startapp', startParam ?? '');
  if (mode) query.set('mode', mode);
  const path = app ? `${botUsername}/${app}` : botUsername;
  return `https://t.me/${path}?${query.toString().replace(/^startapp=(&|$)/, 'startapp$1')}`;
}
