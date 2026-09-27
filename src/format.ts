/**
 * Text formatting.
 *
 * Plain strings are interpreted with the app's `parseMode`:
 * - `markdown` (default): a small Markdown dialect, see `markdownToHtml`
 * - `html`: raw Telegram HTML (you escape)
 * - `markdownv2`: raw Telegram MarkdownV2 (you escape)
 * - `plain`: no formatting
 *
 * The `md` and `html` tagged templates are safe by default: every interpolated
 * value is escaped, so user input can never inject formatting or links.
 *
 *   md`Hello **${user.name}**`         html`Hello <b>${user.name}</b>`
 */
export type ParseMode = 'markdown' | 'html' | 'markdownv2' | 'plain';

/** Already-formatted text produced by `md` / `html`. */
export class Formatted {
  /** @internal */
  constructor(
    readonly html: string,
    /** Markdown source, set for `md` fragments so they can be nested in other `md` templates. */
    readonly markdown?: string,
  ) {}

  toString() {
    return this.html;
  }
}

export type TextPart = string | Formatted;
export type TextInput = TextPart | TextPart[];

export interface ResolvedText {
  text: string;
  parse_mode?: 'HTML' | 'MarkdownV2';
}

// ---- escaping ---------------------------------------------------------------

const MARKDOWN_SPECIAL = /[\\`*_{}\[\]()<>#+\-.!|~=]/g;

/** Escape text for the `markdown` parse mode. */
export function escapeMarkdown(text: string): string {
  return String(text).replace(MARKDOWN_SPECIAL, '\\$&');
}

/** Escape text for the `markdownv2` parse mode. */
export function escapeMarkdownV2(text: string): string {
  return String(text).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
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
  values.forEach((value, i) => {
    source += value instanceof Formatted && value.markdown !== undefined ? value.markdown : escapeMarkdown(stringify(value));
    source += strings[i + 1];
  });
  return new Formatted(markdownToHtml(source), source);
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
export function resolveText(input: TextInput | undefined, mode: ParseMode): ResolvedText {
  if (input === undefined) return { text: '' };
  const parts = Array.isArray(input) ? input : [input];

  if (!parts.some((p) => p instanceof Formatted)) {
    const text = parts.join('\n');
    switch (mode) {
      case 'markdown':
        return { text: markdownToHtml(text), parse_mode: 'HTML' };
      case 'html':
        return { text, parse_mode: 'HTML' };
      case 'markdownv2':
        return { text, parse_mode: 'MarkdownV2' };
      case 'plain':
        return { text };
    }
  }

  if (mode === 'markdownv2') {
    throw new Error('md``/html`` fragments cannot be mixed with plain strings in markdownv2 mode');
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

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
      if (end !== -1) {
        const code = escapeHTML(unescapeMarkdown(lines.slice(i + 1, end).join('\n')));
        out.push(fence[1] ? `<pre><code class="language-${fence[1]}">${code}</code></pre>` : `<pre>${code}</pre>`);
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
        // Escapes inside code are dropped too, so interpolated md`` values show as typed.
        out += `<code>${escapeHTML(unescapeMarkdown(s.slice(i + 1, end)))}</code>`;
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

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()<>#+\-.!|~=])/g, '$1');
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
