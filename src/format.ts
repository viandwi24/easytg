/**
 * Text formatting.
 *
 * Plain strings are interpreted with the app's `parseMode`:
 * - `markdown` (default): a small Markdown dialect, see `markdownToHtml`
 * - `html`: raw Telegram HTML (you escape)
 * - `markdownv2`: raw Telegram MarkdownV2 (you escape)
 * - `markdownv1`: raw legacy Telegram Markdown (`parse_mode: 'Markdown'`, you escape)
 * - `plain`: no formatting
 *
 * The `md` and `html` tagged templates are safe by default: every interpolated
 * value is escaped, so user input can never inject formatting or links.
 *
 *   md`Hello **${user.name}**`         html`Hello <b>${user.name}</b>`
 */
import { escapeMarkdownV1, escapeMarkdownV2, htmlToMarkdownV1, htmlToMarkdownV2 } from './format-convert';
export { escapeMarkdownV1, escapeMarkdownV2, htmlToMarkdownV1, htmlToMarkdownV2 };

export type ParseMode = 'markdown' | 'html' | 'markdownv2' | 'markdownv1' | 'plain';

/**
 * Rewrites every plain string before it is parsed (`EasyTGOptions.transformText`):
 * page and dialogue text, captions, validation messages. Not called for
 * `md`/`html` fragments, `plain` text or easytg's own built-in messages.
 */
export type TextTransform = (text: string, info: { parseMode: Exclude<ParseMode, 'plain'> }) => string;

/** Already-formatted text produced by `md` / `html`. */
export class Formatted {
  /** @internal */
  constructor(
    readonly html: string,
    /** Markdown source, set for `md` fragments so they can be nested in other `md` templates. */
    readonly markdown?: string,
    /** The same as Rich Markdown, values escaped for it: what a `rich` page sends. */
    readonly rich?: string,
  ) {}

  toString() {
    return this.html;
  }
}

export type TextPart = string | Formatted;
export type TextInput = TextPart | TextPart[];

export interface ResolvedText {
  text: string;
  parse_mode?: TelegramParseMode;
}

/** The `parse_mode` values easytg sends. */
export type TelegramParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';

// ---- escaping ---------------------------------------------------------------

const MARKDOWN_SPECIAL = /[\\`*_{}\[\]()<>#+\-.!|~=]/g;

/** Escape text for the `markdown` parse mode. */
export function escapeMarkdown(text: string): string {
  return String(text).replace(MARKDOWN_SPECIAL, '\\$&');
}


/**
 * Escape text for Rich Markdown (`rich` content, Bot API 10.3): a backslash
 * before every ASCII punctuation character, as Markdown allows, so nothing a
 * user typed becomes a heading, list, table, formula or link.
 */
export function escapeRichMarkdown(text: string): string {
  return String(text).replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

/** Escape `text` so it shows as written in `mode`. */
export function escapeFor(mode: ParseMode, text: string): string {
  switch (mode) {
    case 'markdown':
      return escapeMarkdown(text);
    case 'html':
      return escapeHTML(text);
    case 'markdownv2':
      return escapeMarkdownV2(text);
    case 'markdownv1':
      return escapeMarkdownV1(text);
    case 'plain':
      return String(text);
  }
}

/** Escape text for the `html` parse mode. */
export function escapeHTML(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- tagged templates -------------------------------------------------------

/** Markdown template; interpolated values are escaped (nested `md` fragments are kept). */
export function md(strings: TemplateStringsArray, ...values: unknown[]): Formatted {
  let source = strings[0]!;
  let rich = source;
  values.forEach((value, i) => {
    if (value instanceof Formatted && value.markdown !== undefined) {
      source += value.markdown;
      rich += value.rich ?? value.markdown;
    } else {
      // Inside code only `\\` and `\`` are escapes, so values keep every other character as typed.
      const code = insideCode(source);
      source += code ? escapeCode(stringify(value)) : escapeMarkdown(stringify(value));
      // In Rich Markdown code is literal (no escapes): a backtick would end it, so it becomes a look-alike.
      rich += code ? stringify(value).replace(/`/g, '\u02cb') : escapeRichMarkdown(stringify(value));
    }
    source += strings[i + 1];
    rich += strings[i + 1];
  });
  return new Formatted(markdownToHtml(source), source, rich);
}

const FENCE = /^```\s*([\w#+.-]*)\s*$/;

/** Whether the end of `source` is inside a code span or a fenced block. */
function insideCode(source: string): boolean {
  const lines = source.split('\n');
  let fence = false;
  for (const line of lines.slice(0, -1)) {
    if (fence ? line.trim() === '```' : FENCE.test(line)) fence = !fence;
  }
  if (fence) return true;
  let open = false;
  const last = lines.at(-1)!;
  for (let j = 0; j < last.length; j++) {
    if (last[j] === '\\') j++;
    else if (last[j] === '`') open = !open;
  }
  return open;
}

function escapeCode(text: string): string {
  return text.replace(/[\\`]/g, '\\$&');
}

/** Telegram-HTML template; interpolated values are escaped (nested fragments are kept). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Formatted {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += value instanceof Formatted ? value.html : escapeHTML(stringify(value));
    out += strings[i + 1];
  });
  return new Formatted(out);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

// ---- resolution -------------------------------------------------------------

/**
 * Turn page text into what Telegram receives. Arrays are joined with newlines.
 * Plain strings follow `mode`; `md`/`html` fragments carry their own formatting,
 * so any fragment switches the whole message to HTML.
 */
export function resolveText(input: TextInput | undefined, mode: ParseMode, transform?: TextTransform): ResolvedText {
  if (input === undefined) return { text: '' };
  let parts = Array.isArray(input) ? input : [input];
  if (transform && mode !== 'plain') parts = parts.map((part) => (typeof part === 'string' ? transform(part, { parseMode: mode }) : part));

  if (!parts.some((p) => p instanceof Formatted)) {
    const text = parts.join('\n');
    switch (mode) {
      case 'markdown':
        return { text: markdownToHtml(text), parse_mode: 'HTML' };
      case 'html':
        return { text, parse_mode: 'HTML' };
      case 'markdownv2':
        return { text, parse_mode: 'MarkdownV2' };
      case 'markdownv1':
        return { text, parse_mode: 'Markdown' };
      case 'plain':
        return { text };
    }
  }

  if (mode === 'markdownv2' || mode === 'markdownv1') {
    // The fragments are converted to the mode, so they mix with its raw strings.
    const convert = mode === 'markdownv2' ? htmlToMarkdownV2 : htmlToMarkdownV1;
    const text = parts.map((part) => (part instanceof Formatted ? convert(part.html) : part)).join('\n');
    return { text, parse_mode: mode === 'markdownv2' ? 'MarkdownV2' : 'Markdown' };
  }
  const htmlParts = parts.map((part) => {
    if (part instanceof Formatted) return part.html;
    if (mode === 'markdown') return markdownToHtml(part);
    if (mode === 'html') return part;
    return escapeHTML(part);
  });
  return { text: htmlParts.join('\n'), parse_mode: 'HTML' };
}

// ---- markdown -> Telegram HTML ---------------------------------------------

/**
 * The supported Markdown dialect:
 *
 *   **bold**  *italic*  _italic_  __underline__  ~~strike~~  ||spoiler||
 *   `code`  ```lang\npre```  [text](url)  > quote  # heading  - bullet
 *
 * A backslash escapes the next punctuation character. Unmatched markers are
 * shown as-is, and `_` inside words (snake_case, URLs) is never italic.
 */
export function markdownToHtml(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
      if (end !== -1) {
        const code = escapeHTML(unescapeCode(lines.slice(i + 1, end).join('\n')));
        out.push(fence[1] ? `<pre><code class="language-${escapeHTML(fence[1])}">${code}</code></pre>` : `<pre>${code}</pre>`);
        i = end;
        continue;
      }
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote>${quote.map(inline).join('\n')}</blockquote>`);
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1]!)}</b>`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2]!)}`);
      continue;
    }

    out.push(inline(line));
  }
  return out.join('\n');
}

const ESCAPABLE = /[\\`*_{}\[\]()<>#+\-.!|~=]/;
const DELIMITERS: Array<{ mark: string; tag: string; wordBound: boolean }> = [
  { mark: '**', tag: 'b', wordBound: false },
  { mark: '__', tag: 'u', wordBound: true },
  { mark: '~~', tag: 's', wordBound: false },
  { mark: '||', tag: 'tg-spoiler', wordBound: false },
  { mark: '*', tag: 'i', wordBound: false },
  { mark: '_', tag: 'i', wordBound: true },
];

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function inline(s: string): string {
  let out = '';
  let i = 0;

  outer: while (i < s.length) {
    const c = s[i]!;

    if (c === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) {
      out += escapeHTML(s[i + 1]!);
      i += 2;
      continue;
    }

    if (c === '`') {
      const end = codeSpanEnd(s, i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHTML(unescapeCode(s.slice(i + 1, end)))}</code>`;
        i = end + 1;
        continue;
      }
    }

    if (c === '[') {
      const link = parseLink(s, i);
      if (link) {
        out += `<a href="${escapeHTML(link.url)}">${inline(link.text)}</a>`;
        i = link.end;
        continue;
      }
    }

    for (const { mark, tag, wordBound } of DELIMITERS) {
      if (!s.startsWith(mark, i)) continue;
      const after = s[i + mark.length];
      if (isSpace(after) || (wordBound && isWordChar(s[i - 1]))) continue;
      const end = findClosing(s, mark, i + mark.length, wordBound);
      if (end === -1) continue;
      out += `<${tag}>${inline(s.slice(i + mark.length, end))}</${tag}>`;
      i = end + mark.length;
      continue outer;
    }

    out += escapeHTML(c);
    i++;
  }
  return out;
}

/** Index of the backtick closing a code span, skipping escaped backticks; -1 if none. */
function codeSpanEnd(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j;
  }
  return -1;
}

/** In code only a backslash before `\` or a backtick is an escape, so e.g. `\d` in a regex stays as written. */
function unescapeCode(text: string): string {
  return text.replace(/\\([\\`])/g, '$1');
}

function findClosing(s: string, mark: string, from: number, wordBound: boolean): number {
  for (let j = from; j < s.length; j++) {
    const c = s[j]!;
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(s, j + 1);
      if (end !== -1) j = end;
      continue;
    }
    if (!s.startsWith(mark, j) || j === from) continue;
    // `*` must not close on half of a `**`
    if (mark.length === 1 && (s[j + 1] === mark || s[j - 1] === mark)) continue;
    if (isSpace(s[j - 1])) continue;
    if (wordBound && isWordChar(s[j + mark.length])) continue;
    return j;
  }
  return -1;
}

function parseLink(s: string, start: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    if (c === ']' && --depth === 0) {
      if (s[j + 1] !== '(') return null;
      let url = '';
      let parens = 0;
      for (let k = j + 2; k < s.length; k++) {
        const u = s[k]!;
        if (u === '\\' && k + 1 < s.length) {
          url += s[++k];
          continue;
        }
        if (u === '(') parens++;
        if (u === ')' && parens-- === 0) return { text: s.slice(start + 1, j), url: url.trim(), end: k + 1 };
        if (u === ' ' || u === '\n') return null;
        url += u;
      }
      return null;
    }
  }
  return null;
}
