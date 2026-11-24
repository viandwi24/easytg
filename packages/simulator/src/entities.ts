/**
 * Turns `text` + `parse_mode` into plain text and entities, the way Telegram
 * does, and fails with Telegram's errors on markup Telegram would reject.
 */
import type { MessageEntity } from 'grammy/types';

export class ParseError extends Error {}

export interface Formatted {
  text: string;
  entities: MessageEntity[];
}

export function parseFormatted(text: string, parseMode: string | undefined, entities: MessageEntity[] | undefined): Formatted {
  const mode = parseMode?.toLowerCase();
  const result = mode === 'html' ? parseHtml(text) : mode === 'markdownv2' ? parseMarkdownV2(text) : mode === 'markdown' ? parseMarkdownV2(text, true) : { text, entities: entities ?? [] };
  if (parseMode && !['html', 'markdownv2', 'markdown'].includes(mode!)) throw new ParseError(`unsupported parse_mode "${parseMode}"`);
  return { text: result.text, entities: withDetected(result.text, sortEntities(result.entities)) };
}

function sortEntities(entities: MessageEntity[]) {
  return entities.filter((e) => e.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length);
}

/* ---------------------------------- HTML ---------------------------------- */

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

function decodeEntity(source: string, at: number): [string, number] {
  const end = source.indexOf(';', at);
  if (end > at && end - at < 12) {
    const name = source.slice(at + 1, end);
    if (name in NAMED) return [NAMED[name]!, end + 1];
    const numeric = /^#(x[0-9a-f]+|\d+)$/i.exec(name);
    if (numeric) {
      const code = numeric[1]![0]!.toLowerCase() === 'x' ? Number.parseInt(numeric[1]!.slice(1), 16) : Number(numeric[1]);
      if (code > 0 && code <= 0x10ffff) return [String.fromCodePoint(code), end + 1];
    }
  }
  return ['&', at + 1]; // Telegram keeps an unknown "&" as it is
}

interface OpenTag {
  tag: string;
  offset: number;
  entity: Omit<MessageEntity, 'offset' | 'length'> | null;
}

export function parseHtml(source: string): Formatted {
  let text = '';
  const entities: MessageEntity[] = [];
  const stack: OpenTag[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '&') {
      const [decoded, next] = decodeEntity(source, i);
      text += decoded;
      i = next;
      continue;
    }
    if (char !== '<') {
      text += char;
      i++;
      continue;
    }
    const end = source.indexOf('>', i);
    if (end < 0) throw new ParseError(`Can't find end of the tag starting at byte offset ${i}`);
    const inner = source.slice(i + 1, end).trim();
    i = end + 1;
    if (inner.startsWith('/')) {
      const tag = inner.slice(1).trim().toLowerCase();
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new ParseError(`Unmatched end tag at byte offset ${end}, expected "</${open?.tag ?? ''}>", found "</${tag}>"`);
      if (open.entity) entities.push({ ...open.entity, offset: open.offset, length: text.length - open.offset } as MessageEntity);
      continue;
    }
    const name = /^[a-z0-9-]+/i.exec(inner)?.[0]?.toLowerCase() ?? '';
    const attrs = parseAttributes(inner.slice(name.length));
    stack.push({ tag: name, offset: text.length, entity: htmlEntity(name, attrs, stack) });
  }
  if (stack.length) throw new ParseError(`Can't find end tag corresponding to start tag "${stack.at(-1)!.tag}"`);
  return { text, entities: mergePreCode(entities) };
}

function parseAttributes(source: string) {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([a-z-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/gi)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[match[1]!.toLowerCase()] = raw.replace(/&(lt|gt|amp|quot);/g, (_, n: string) => NAMED[n]!);
  }
  return attrs;
}

function htmlEntity(tag: string, attrs: Record<string, string>, stack: OpenTag[]): OpenTag['entity'] {
  switch (tag) {
    case 'b':
    case 'strong':
      return { type: 'bold' };
    case 'i':
    case 'em':
      return { type: 'italic' };
    case 'u':
    case 'ins':
      return { type: 'underline' };
    case 's':
    case 'strike':
    case 'del':
      return { type: 'strikethrough' };
    case 'tg-spoiler':
      return { type: 'spoiler' };
    case 'span':
      if (attrs.class === 'tg-spoiler') return { type: 'spoiler' };
      throw new ParseError('Tag "span" must have class "tg-spoiler"');
    case 'a': {
      const href = attrs.href ?? '';
      const user = /^tg:\/\/user\?id=(\d+)$/.exec(href);
      if (user) return { type: 'text_mention', user: { id: Number(user[1]), is_bot: false, first_name: '' } } as never;
      return href ? ({ type: 'text_link', url: href } as never) : null;
    }
    case 'code': {
      const language = /^language-(.+)$/.exec(attrs.class ?? '')?.[1];
      if (stack.at(-1)?.tag === 'pre' && language) return { type: 'pre', language } as never;
      return { type: 'code' };
    }
    case 'pre':
      return { type: 'pre' };
    case 'blockquote':
      return { type: 'expandable' in attrs ? 'expandable_blockquote' : 'blockquote' } as never;
    case 'tg-emoji':
      return { type: 'custom_emoji', custom_emoji_id: attrs['emoji-id'] ?? '' } as never;
    default:
      throw new ParseError(`Unsupported start tag "${tag}"`);
  }
}

/** `<pre><code class="language-x">` is one entity: a pre with a language. */
function mergePreCode(entities: MessageEntity[]) {
  return entities.filter((entity) => {
    if (entity.type !== 'pre' || 'language' in entity) return true;
    return !entities.some((other) => other !== entity && other.type === 'pre' && 'language' in other && other.offset === entity.offset && other.length === entity.length);
  });
}

/* ------------------------------- MarkdownV2 ------------------------------- */

const RESERVED = '_*[]()~`>#+-=|{}.!';

export function parseMarkdownV2(source: string, legacy = false): Formatted {
  let text = '';
  const entities: MessageEntity[] = [];
  const open: { marker: string; offset: number }[] = [];
  let lineStart = true;
  let quote: { offset: number; expandable: boolean } | null = null;
  const closeQuote = () => {
    if (!quote) return;
    let length = text.length - quote.offset;
    if (text.endsWith('\n')) length--;
    entities.push({ type: quote.expandable ? 'expandable_blockquote' : 'blockquote', offset: quote.offset, length } as MessageEntity);
    quote = null;
  };
  const toggle = (marker: string, type: MessageEntity['type']) => {
    const index = open.findLastIndex((o) => o.marker === marker);
    if (index >= 0) {
      const [start] = open.splice(index, 1);
      entities.push({ type, offset: start!.offset, length: text.length - start!.offset } as MessageEntity);
    } else open.push({ marker, offset: text.length });
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (lineStart) {
      lineStart = false;
      if (!legacy && char === '>') {
        quote ??= { offset: text.length, expandable: false };
        i++;
        continue;
      }
      closeQuote();
      if (!legacy && source.startsWith('**>', i)) {
        quote = { offset: text.length, expandable: true };
        i += 3;
        continue;
      }
    }
    // "||" at the end of an expandable quote closes it.
    if (quote?.expandable && source.startsWith('||', i) && (i + 2 === source.length || source[i + 2] === '\n')) {
      i += 2;
      continue;
    }
    if (char === '\\' && !legacy) {
      const next = source[i + 1];
      if (next === undefined) throw new ParseError('Character "\\" is reserved and must be escaped with the preceding "\\"');
      text += next;
      i += 2;
      continue;
    }
    if (char === '\n') {
      text += char;
      i++;
      lineStart = true;
      continue;
    }
    if (char === '`') {
      const fence = source.startsWith('```', i);
      const marker = fence ? '```' : '`';
      const close = findUnescaped(source, marker, i + marker.length);
      if (close < 0) throw new ParseError(`Can't find end of ${fence ? 'Pre' : 'Code'} entity at byte offset ${i}`);
      let body = source.slice(i + marker.length, close);
      let language: string | undefined;
      if (fence) {
        const newline = body.indexOf('\n');
        if (newline >= 0 && /^[\w+#-]*$/.test(body.slice(0, newline))) {
          language = body.slice(0, newline) || undefined;
          body = body.slice(newline + 1);
        }
      }
      body = body.replace(/\\([\\`])/g, '$1');
      entities.push({ type: fence ? 'pre' : 'code', offset: text.length, length: body.length, ...(language ? { language } : {}) } as MessageEntity);
      text += body;
      i = close + marker.length;
      continue;
    }
    if (char === '[') {
      const close = findUnescaped(source, '](', i + 1);
      const end = close < 0 ? -1 : findUnescaped(source, ')', close + 2);
      if (close < 0 || end < 0) throw new ParseError(`Can't find end of a URL at byte offset ${i}`);
      const inner = parseMarkdownV2(source.slice(i + 1, close), legacy);
      const url = source.slice(close + 2, end).replace(/\\([)\\])/g, '$1');
      const user = /^tg:\/\/user\?id=(\d+)$/.exec(url);
      entities.push(
        user
          ? ({ type: 'text_mention', offset: text.length, length: inner.text.length, user: { id: Number(user[1]), is_bot: false, first_name: '' } } as MessageEntity)
          : ({ type: 'text_link', offset: text.length, length: inner.text.length, url } as MessageEntity),
      );
      for (const entity of inner.entities) entities.push({ ...entity, offset: entity.offset + text.length });
      text += inner.text;
      i = end + 1;
      continue;
    }
    if (source.startsWith('__', i) && !legacy) {
      toggle('__', 'underline');
      i += 2;
      continue;
    }
    if (source.startsWith('||', i) && !legacy) {
      toggle('||', 'spoiler');
      i += 2;
      continue;
    }
    if (char === '*') {
      toggle('*', 'bold');
      i++;
      continue;
    }
    if (char === '_') {
      toggle('_', 'italic');
      i++;
      continue;
    }
    if (char === '~' && !legacy) {
      toggle('~', 'strikethrough');
      i++;
      continue;
    }
    if (!legacy && RESERVED.includes(char)) {
      throw new ParseError(`Character '${char}' is reserved and must be escaped with the preceding '\\'`);
    }
    text += char;
    i++;
  }
  closeQuote();
  if (open.length) throw new ParseError(`Can't find end of the entity starting at byte offset ${open[0]!.offset}`);
  return { text, entities };
}

function findUnescaped(source: string, marker: string, from: number) {
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source.startsWith(marker, i)) return i;
  }
  return -1;
}

/* ----------------------------- auto-detection ----------------------------- */

const DETECT = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|((?<![\w/])\/[a-zA-Z0-9_]{1,32}(?:@[a-zA-Z0-9_]{5,32})?)(?![\w/])|((?<![\w@])@[a-zA-Z][a-zA-Z0-9_]{4,31})\b|((?<![\w#])#[\p{L}\p{N}_]+)/gu;

/** Links, /commands, @mentions and #hashtags Telegram finds by itself. */
function withDetected(text: string, entities: MessageEntity[]): MessageEntity[] {
  const covered = (from: number, to: number) =>
    entities.some((e) => ['code', 'pre', 'text_link', 'text_mention', 'url'].includes(e.type) && e.offset < to && from < e.offset + e.length);
  const found: MessageEntity[] = [];
  for (const match of text.matchAll(DETECT)) {
    const offset = match.index!;
    const length = match[0].length;
    if (covered(offset, offset + length)) continue;
    const type = match[1] ? 'url' : match[2] ? 'bot_command' : match[3] ? 'mention' : 'hashtag';
    found.push({ type, offset, length } as MessageEntity);
  }
  return found.length ? sortEntities([...entities, ...found]) : entities;
}
