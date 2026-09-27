import { EasyTGError } from './errors';

/**
 * Callback data wire format:
 *
 *   p|<id>|<urlencoded params>   open a page / start a dialogue (params inline)
 *   s|<token>                    same, with params stored server-side
 *   p|_db|<...>                  dialogue control (answers, back, cancel, done)
 *   p|exit                       close the message
 *
 * Callback data is NOT trusted input: modified clients can send any string.
 */
export const MAX_CALLBACK_BYTES = 64;
export const DIALOGUE_BUTTON_ID = '_db';
export const EXIT_ID = 'exit';
/** Callback id of `nav.back()`. */
export const BACK_ID = '_bk';

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type ParamValue = string | number | boolean | null | undefined;
export type ParamsInput = Record<string, ParamValue>;

export interface DecodedCallback {
  id: string;
  params: Record<string, string>;
}

const encoder = new TextEncoder();
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Ids of pages and dialogues: letters, digits, `_ . : -`, not starting with `_`, not `exit`. */
export function assertValidId(kind: string, id: string) {
  if (!id || !ID_PATTERN.test(id) || id.startsWith('_') || id === EXIT_ID) {
    throw new EasyTGError(
      `Invalid ${kind} id "${id}": use letters, digits and _ . : - (not starting with "_", and "exit" is reserved)`,
    );
  }
}

/** Drop null/undefined and stringify, i.e. exactly what the page will receive. */
export function normalizeParams(params: ParamsInput = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

export function encodeInline(id: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `p|${id}|${query}` : `p|${id}`;
}

export function fitsCallback(data: string) {
  return byteLength(data) <= MAX_CALLBACK_BYTES;
}

export function assertFits(data: string) {
  if (!fitsCallback(data)) {
    throw new EasyTGError(
      `Callback data is ${byteLength(data)} bytes, Telegram allows at most ${MAX_CALLBACK_BYTES}: "${data}". ` +
        "Use callbackParams: 'auto' or 'stored', or { store: true } on the button.",
    );
  }
}

/** Returns null when the data isn't an inline easytg callback. */
export function decodeInline(data: string): DecodedCallback | null {
  const parts = data.split('|');
  if (parts[0] !== 'p' || !parts[1] || !ID_PATTERN.test(parts[1])) return null;
  return { id: parts[1], params: Object.fromEntries(new URLSearchParams(parts.slice(2).join('|'))) };
}

export function decodeStoredToken(data: string): string | null {
  const match = /^s\|([A-Za-z0-9_-]{8,48})$/.exec(data);
  return match ? match[1]! : null;
}
