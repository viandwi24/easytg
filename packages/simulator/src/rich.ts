/**
 * Rich messages (Bot API 10.3) in the simulator: what `sendRichMessage` gets
 * (Rich Markdown, Rich HTML or blocks) turned into the `RichMessage` blocks a
 * Telegram message carries, their plain text, their buttons, and HTML for a
 * chat window.
 *
 * The parser covers what bots use (headings, paragraphs, lists, task lists,
 * quotes, code, formulas, tables, details, media, maps, buttons and inline
 * formatting); it isn't Telegram's parser. Unsupported HTML tags and media
 * that isn't an http(s) URL or a `tg://…?id=` reference are errors, as in
 * Telegram. Plain URLs, mentions and commands aren't detected.
 */
import type { RichBlock, RichBlockCaption, RichBlockListItem, RichBlockTableCell, RichMessage, RichMessageButton, RichText } from 'grammy/types';

export type RichMediaKind = 'photo' | 'video' | 'animation' | 'audio' | 'document' | 'voice_note';

/**
 * Turns a media source (a URL, a file id, an uploaded file) into a media
 * block; the simulator registers the file. `tg://photo?id=…` references are
 * resolved to the message's `media` list before it is called.
 */
export type RichMediaResolver = (kind: RichMediaKind, source: unknown, extra: { caption?: RichBlockCaption; spoiler?: boolean }) => RichBlock;

/** A rich message Telegram would refuse; the message is the description after "Bad Request: ". */
export class RichMessageError extends Error {}

interface Ctx {
  media: RichMediaResolver;
  /** `media` of the input, by id (for `tg://photo?id=…` links). */
  refs: Map<string, { type: string; media: unknown }>;
}

/** Content of a `sendRichMessage` / `editMessageText` call as the message's `rich_message`. */
export function parseRichMessage(input: Record<string, any>, media: RichMediaResolver): RichMessage {
  const given = ['blocks', 'html', 'markdown'].filter((k) => input[k] !== undefined);
  if (given.length !== 1) throw new RichMessageError('exactly one of rich_message.blocks, rich_message.html and rich_message.markdown must be specified');
  const refs = new Map<string, { type: string; media: unknown }>();
  for (const item of (input.media ?? []) as { id: string; media: { type: string; media: unknown } }[]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(item.id))) throw new RichMessageError('invalid rich message media identifier');
    refs.set(item.id, item.media);
  }
  const ctx: Ctx = { media, refs };
  const blocks =
    input.blocks !== undefined
      ? inputBlocks(input.blocks as Record<string, any>[], ctx)
      : input.html !== undefined
        ? htmlBlocks(parseHtmlTree(String(input.html)), ctx)
        : markdownBlocks(String(input.markdown).replace(/\r\n?/g, '\n').split('\n'), ctx);
  if (!blocks.length || !plainOfBlocks(blocks).trim() && !blocks.some((b) => !TEXT_BLOCKS.has(b.type))) throw new RichMessageError('message text is empty');
  checkButtons(blocks);
  return { blocks, ...(input.is_rtl ? { is_rtl: true } : {}) };
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'pre', 'footer']);

/* --------------------------------- blocks --------------------------------- */

const MEDIA_FIELD: Record<RichMediaKind, string> = { photo: 'photo', video: 'video', animation: 'animation', audio: 'audio', document: 'document', voice_note: 'voice_note' };

function inputBlocks(blocks: Record<string, any>[], ctx: Ctx): RichBlock[] {
  if (!Array.isArray(blocks)) throw new RichMessageError('rich_message.blocks must be an Array');
  return blocks.map((block) => {
    const kind = block.type as string;
    if (kind in MEDIA_FIELD) {
      const input = block[MEDIA_FIELD[kind as RichMediaKind]] as { media?: unknown } | undefined;
      return ctx.media(kind as RichMediaKind, input?.media, { caption: block.caption, spoiler: !!(input as { has_spoiler?: boolean } | undefined)?.has_spoiler });
    }
    switch (kind) {
      case 'list': {
        // Items with a number (`value`) or a numbering `type` make an ordered list; others get bullets.
        const items = block.items as Record<string, any>[];
        const ordered = items.some((item) => item.value !== undefined || item.type !== undefined);
        let n = 0;
        return {
          type: 'list',
          items: items.map((item) => {
            n = item.value ?? n + 1;
            const label = item.has_checkbox ? '' : ordered ? `${numberLabel(n, item.type ?? '1')}.` : '•';
            return { ...item, label, blocks: inputBlocks(item.blocks, ctx) };
          }),
        } as RichBlock;
      }
      case 'blockquote':
      case 'collage':
      case 'slideshow':
      case 'details':
        return { ...block, blocks: inputBlocks(block.blocks, ctx) } as RichBlock;
      case 'paragraph':
      case 'heading':
      case 'pre':
      case 'footer':
      case 'divider':
      case 'mathematical_expression':
      case 'anchor':
      case 'expandable_blockquote':
      case 'pullquote':
      case 'table':
      case 'map':
      case 'buttons':
      case 'thinking':
        return block as RichBlock;
      default:
        throw new RichMessageError(`unsupported rich block type "${kind}"`);
    }
  });
}

/** A media block from a URL or a `tg://photo?id=…` reference. */
function mediaBlock(kind: RichMediaKind | undefined, src: string, ctx: Ctx, extra: { caption?: RichBlockCaption; spoiler?: boolean }): RichBlock {
  const ref = /^tg:\/\/(photo|video|document|audio)\?id=([^&\s]+)/.exec(src);
  if (ref) {
    const item = ctx.refs.get(decodeURIComponent(ref[2]!));
    if (!item) throw new RichMessageError(`media "${ref[2]}" not found in rich_message.media`);
    const type = item.type === 'voice' ? 'voice_note' : (item.type as RichMediaKind);
    return ctx.media(type, item.media, extra);
  }
  if (!/^https?:\/\//i.test(src)) throw new RichMessageError('media blocks support only HTTP and HTTPS URLs');
  return ctx.media(kind ?? kindOfUrl(src), src, extra);
}

/** Telegram picks the media type from the URL (and the file's MIME type, which the simulator doesn't fetch). */
function kindOfUrl(url: string): RichMediaKind {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) return 'photo';
  if (ext === 'gif') return 'animation';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['ogg', 'oga', 'opus'].includes(ext)) return 'voice_note';
  if (['mp3', 'm4a', 'flac', 'wav', 'aac'].includes(ext)) return 'audio';
  return 'document';
}

function checkButtons(blocks: RichBlock[]) {
  for (const button of richButtons({ blocks })) {
    if ('callback_data' in button && new TextEncoder().encode(button.callback_data).length > 64) throw new RichMessageError('BUTTON_DATA_INVALID');
  }
}

/* -------------------------------- markdown -------------------------------- */

const HTML_BLOCK = /^\s*<(p|h[1-6]|pre|footer|hr|ul|ol|blockquote|aside|img|video|audio|tg-document|figure|tg-map|table|tg-math-block|tg-button-row|a\s+name=)[\s>/]/i;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const MEDIA_LINE = /^\s*!\[[^\]]*\]\((\S+?)(?:\s+"((?:[^"\\]|\\.)*)")?\)\s*$/;

function markdownBlocks(lines: string[], ctx: Ctx): RichBlock[] {
  const out: RichBlock[] = [];
  let i = 0;
  const startsBlock = (line: string, next: string | undefined) =>
    FENCE.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-')) ||
    MEDIA_LINE.test(line) && !/^\s*!\[[^\]]*\]\(tg:\/\/(emoji|time)/.test(line) ||
    HTML_BLOCK.test(line) ||
    /^\s*<(details|tg-collage|tg-slideshow)\b/i.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(fence[1]![0]!.repeat(fence[1]!.length)) && /^\s*(`{3,}|~{3,})\s*$/.test(lines[i]!))) body.push(lines[i++]!);
      i++;
      const language = fence[2] || undefined;
      out.push(language === 'math' ? { type: 'mathematical_expression', expression: body.join('\n') } : { type: 'pre', text: body.join('\n'), ...(language ? { language } : {}) });
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      let source = line.trim().slice(2);
      while (!source.trimEnd().endsWith('$$') && i + 1 < lines.length) source += `\n${lines[++i]}`;
      i++;
      out.push({ type: 'mathematical_expression', expression: source.trimEnd().replace(/\$\$$/, '').trim() });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push({ type: 'heading', size: heading[1]!.length as 1, text: inlineMarkdown(heading[2]!, ctx) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: 'divider' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*> ?/, ''));
      out.push({ type: 'blockquote', blocks: markdownBlocks(body, ctx) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = markdownList(lines, i, ctx);
      out.push(list);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const aligns = cellsOf(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      const row = (source: string, header: boolean): RichBlockTableCell[] =>
        cellsOf(source).map((cell, c) => ({ text: inlineMarkdown(cell, ctx), ...(header ? { is_header: true as const } : {}), align: (aligns[c] ?? 'left') as 'left', valign: 'top' }));
      const cells = [row(line, true)];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) cells.push(row(lines[i++]!, false));
      out.push({ type: 'table', cells });
      continue;
    }
    const footnote = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      out.push({ type: 'paragraph', text: [{ type: 'reference', name: footnote[1]!, text: `${footnote[1]}. ` }, inlineMarkdown(footnote[2]!, ctx)] });
      i++;
      continue;
    }
    const mediaLine = MEDIA_LINE.exec(line);
    if (mediaLine && !/^tg:\/\/(emoji|time)/.test(mediaLine[1]!)) {
      const caption = mediaLine[2] ? { text: mediaLine[2].replace(/\\(.)/g, '$1') } : undefined;
      out.push(mediaBlock(undefined, mediaLine[1]!, ctx, { caption }));
      i++;
      continue;
    }
    const container = /^\s*<(details|tg-collage|tg-slideshow)\b([^>]*)>\s*(.*)$/i.exec(line);
    if (container) {
      const tag = container[1]!.toLowerCase();
      let rest = container[3]!;
      let summary: RichText = '';
      if (tag === 'details') {
        const s = /^<summary>(.*?)<\/summary>\s*(.*)$/i.exec(rest);
        if (s) {
          summary = inlineMarkdown(s[1]!, ctx);
          rest = s[2]!;
        }
      }
      const body: string[] = rest ? [rest] : [];
      let depth = 1;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        depth += (l.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length - (l.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length;
        if (depth <= 0) {
          const before = l.replace(new RegExp(`</${tag}>\\s*$`, 'i'), '');
          if (before.trim()) body.push(before);
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      const blocks = markdownBlocks(body, ctx);
      if (tag === 'details') out.push({ type: 'details', summary, blocks, ...(/\bopen\b/i.test(container[2]!) ? { is_open: true as const } : {}) });
      else out.push({ type: tag === 'tg-collage' ? 'collage' : 'slideshow', blocks });
      continue;
    }
    if (HTML_BLOCK.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim()) body.push(lines[i++]!);
      out.push(...htmlBlocks(parseHtmlTree(body.join('\n')), ctx));
      continue;
    }
    const body: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) body.push(lines[i++]!);
    out.push({ type: 'paragraph', text: inlineMarkdown(body.join('\n'), ctx) });
  }
  return out;
}

function cellsOf(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

/** A list from line `start`: items, their indented continuation lines and nested lists. */
function markdownList(lines: string[], start: number, ctx: Ctx): [RichBlock, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]![0]!);
  const items: RichBlockListItem[] = [];
  let i = start;
  let n = ordered ? Number.parseInt(first[2]!, 10) : 1;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]![0]!) !== ordered) break;
    const contentIndent = m[1]!.length + m[2]!.length + 1;
    const body = [m[3]!];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        const next = lines[i + 1];
        if (next !== undefined && next.trim() && next.length - next.trimStart().length >= contentIndent) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      const lead = l.length - l.trimStart().length;
      if (lead >= contentIndent || (lead > indent && LIST_ITEM.test(l))) body.push(l.slice(Math.min(lead, contentIndent)));
      else if (!LIST_ITEM.test(l) && !/^\s*(>|#|```)/.test(l)) body.push(l.trim()); // a lazy continuation line
      else break;
      i++;
    }
    const task = /^\[([ xX])\]\s+(.*)$/s.exec(body[0]!);
    if (task) body[0] = task[2]!;
    items.push({
      label: task ? '' : ordered ? `${n}.` : '•',
      blocks: markdownBlocks(body, ctx),
      ...(task ? { has_checkbox: true as const, ...(task[1] !== ' ' ? { is_checked: true as const } : {}) } : {}),
      ...(ordered ? { value: n } : {}),
    });
    n++;
    while (i < lines.length && !lines[i]!.trim() && LIST_ITEM.exec(lines[i + 1] ?? '')?.[1]?.length === indent) i++;
  }
  return [{ type: 'list', items }, i];
}

const PAIRS: [string, RichTextKind][] = [
  ['**', 'bold'],
  ['__', 'bold'],
  ['~~', 'strikethrough'],
  ['==', 'marked'],
  ['||', 'spoiler'],
  ['*', 'italic'],
  ['_', 'italic'],
];
type RichTextKind = 'bold' | 'italic' | 'strikethrough' | 'marked' | 'spoiler';
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Inline Rich Markdown: emphasis, code, links, formulas, references and inline HTML. */
function inlineMarkdown(s: string, ctx: Ctx): RichText {
  const parts: RichText[] = [];
  let buf = '';
  const flush = () => {
    if (buf) parts.push(buf);
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && PUNCTUATION.test(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) {
        let code = s.slice(i + run.length, close).replace(/\n/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        flush();
        parts.push({ type: 'code', text: code });
        i = close + run.length;
        continue;
      }
    }
    if (c === '<') {
      const tag = inlineHtmlAt(s, i, ctx);
      if (tag) {
        flush();
        parts.push(tag.text);
        i = tag.end;
        continue;
      }
    }
    if (c === '!' && s[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\((tg:\/\/(emoji|time)\?[^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        flush();
        const query = new URLSearchParams(m[2]!.split('?')[1]);
        parts.push(
          m[3] === 'emoji'
            ? { type: 'custom_emoji', custom_emoji_id: query.get('id') ?? '', alternative_text: m[1]! }
            : { type: 'date_time', text: m[1]!, unix_time: Number(query.get('unix')), date_time_format: (query.get('format') ?? 'r') as 'r' },
        );
        i += m[0].length;
        continue;
      }
    }
    if (c === '[' && s[i + 1] === '^') {
      const m = /^\[\^([^\]]+)\]/.exec(s.slice(i));
      if (m) {
        flush();
        parts.push({ type: 'reference_link', text: `[${m[1]}]`, reference_name: m[1]! });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const end = closingBracket(s, i);
      const m = end > 0 ? /^\((\S+?)(?:\s+"[^"]*")?\)/.exec(s.slice(end + 1)) : null;
      if (m) {
        flush();
        parts.push(linkText(m[1]!, inlineMarkdown(s.slice(i + 1, end), ctx)));
        i = end + 1 + m[0].length;
        continue;
      }
    }
    if (c === '$' && s[i + 1] !== '$' && s[i + 1] && !/\s/.test(s[i + 1]!)) {
      const close = s.indexOf('$', i + 1);
      if (close > i + 1 && !/\s/.test(s[close - 1]!) && !s.slice(i + 1, close).includes('\n')) {
        flush();
        parts.push({ type: 'mathematical_expression', expression: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    const pair = PAIRS.find(([mark]) => s.startsWith(mark, i));
    if (pair) {
      const [mark, kind] = pair;
      const close = closingMark(s, mark, i + mark.length);
      const opens = s[i + mark.length] !== undefined && !/\s/.test(s[i + mark.length]!);
      // `_` inside a word (snake_case) is never emphasis.
      const intraword = mark[0] === '_' && /\w/.test(s[i - 1] ?? '');
      if (close > 0 && opens && !intraword) {
        flush();
        parts.push({ type: kind, text: inlineMarkdown(s.slice(i + mark.length, close), ctx) } as RichText);
        i = close + mark.length;
        continue;
      }
      buf += mark;
      i += mark.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return simplify(parts);
}

function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function closingMark(s: string, mark: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '`') {
      const close = s.indexOf('`', i + 1);
      if (close > 0) i = close;
      continue;
    }
    if (s.startsWith(mark, i) && i > from && !/\s/.test(s[i - 1]!)) {
      // `**` closes `*…*` only when it isn't the start of a `**`-pair inside.
      if (mark.length === 1 && s[i + 1] === mark && s[i + 2] !== mark && closingMark(s, mark + mark, i + 2) > 0) {
        i = closingMark(s, mark + mark, i + 2) + 1;
        continue;
      }
      if (mark[0] === '_' && /\w/.test(s[i + mark.length] ?? '')) continue;
      return i;
    }
  }
  return -1;
}

/* ---------------------------------- HTML ---------------------------------- */

type HtmlNode = string | { tag: string; attrs: Record<string, string>; children: HtmlNode[] };

const VOID = new Set(['br', 'hr', 'img', 'input', 'tg-map']);
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'footer', 'hr', 'ul', 'ol', 'blockquote', 'aside', 'video', 'audio', 'tg-document', 'figure', 'tg-map', 'tg-collage', 'tg-slideshow', 'table', 'details', 'tg-math-block', 'tg-button-row']);
const INLINE_TAGS: Record<string, RichTextKind | 'underline' | 'code' | 'subscript' | 'superscript'> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strikethrough',
  strike: 'strikethrough',
  del: 'strikethrough',
  code: 'code',
  mark: 'marked',
  sub: 'subscript',
  sup: 'superscript',
  'tg-spoiler': 'spoiler',
};
const OTHER_TAGS = new Set(['a', 'br', 'img', 'input', 'cite', 'figcaption', 'summary', 'caption', 'tr', 'td', 'th', 'li', 'tg-reference', 'tg-emoji', 'tg-time', 'tg-math', 'tg-button']);
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([a-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/gi)) attrs[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function checkTag(tag: string) {
  if (!BLOCK_TAGS.has(tag) && !(tag in INLINE_TAGS) && !OTHER_TAGS.has(tag)) throw new RichMessageError(`can't parse rich message: unsupported tag <${tag}>`);
}

function parseHtmlTree(source: string): HtmlNode[] {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: Exclude<HtmlNode, string>[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/gi;
  let last = 0;
  for (const m of source.matchAll(re)) {
    const top = stack.at(-1)!;
    if (m.index! > last) top.children.push(decode(source.slice(last, m.index)));
    last = m.index! + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const tag = m[2]!.toLowerCase();
    checkTag(tag);
    const node = { tag, attrs: parseAttrs(m[3] ?? ''), children: [] as HtmlNode[] };
    top.children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  if (last < source.length) stack.at(-1)!.children.push(decode(source.slice(last)));
  return root.children;
}

/** An inline HTML tag at `at` inside Rich Markdown (its content is Markdown again). */
function inlineHtmlAt(s: string, at: number, ctx: Ctx): { text: RichText; end: number } | undefined {
  const open = /^<([a-z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/i.exec(s.slice(at));
  if (!open) return undefined;
  const tag = open[1]!.toLowerCase();
  if (!(tag in INLINE_TAGS) && !['a', 'br', 'img', 'tg-reference', 'tg-emoji', 'tg-time', 'tg-math', 'tg-button'].includes(tag)) return undefined;
  const attrs = parseAttrs(open[2] ?? '');
  const start = at + open[0].length;
  if (tag === 'br') return { text: '\n', end: start };
  if (tag === 'img' || open[3]) return { text: inlineNode({ tag, attrs, children: [] }, ctx), end: start };
  // The matching close tag, counting nested ones of the same name.
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      const inner = s.slice(start, m.index);
      const text = tag === 'code' || tag === 'tg-math' ? decode(inner) : inlineMarkdown(inner, ctx);
      return { text: tagText(tag, attrs, text, ctx), end: m.index + m[0].length };
    }
  }
  return undefined;
}

/** Inline content of HTML nodes; whitespace collapses as in HTML. */
function inlineNodes(nodes: HtmlNode[], ctx: Ctx, pre = false): RichText {
  return simplify(nodes.map((n) => (typeof n === 'string' ? (pre ? n : n.replace(/\s+/g, ' ')) : inlineNode(n, ctx))));
}

function inlineNode(node: Exclude<HtmlNode, string>, ctx: Ctx): RichText {
  const { tag, attrs } = node;
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const emoji = /^tg:\/\/emoji\?id=(\d+)/.exec(attrs.src ?? '');
    if (!emoji) throw new RichMessageError('images can be specified only as separate media blocks');
    return { type: 'custom_emoji', custom_emoji_id: emoji[1]!, alternative_text: attrs.alt ?? '' };
  }
  if (tag === 'cite' || tag === 'input') return '';
  const raw = tag === 'code' || tag === 'tg-math' ? textOf(node.children) : inlineNodes(node.children, ctx);
  return tagText(tag, attrs, raw, ctx);
}

function tagText(tag: string, attrs: Record<string, string>, text: RichText, ctx: Ctx): RichText {
  const kind = INLINE_TAGS[tag];
  if (kind) return { type: kind, text } as RichText;
  switch (tag) {
    case 'a':
      if (attrs.href === undefined) return attrs.name !== undefined ? simplify([{ type: 'anchor', name: attrs.name }, text]) : text;
      return linkText(attrs.href, text);
    case 'tg-reference':
      return { type: 'reference', name: attrs.name ?? '', text };
    case 'tg-emoji':
      return { type: 'custom_emoji', custom_emoji_id: attrs['emoji-id'] ?? '', alternative_text: plainOf(text) };
    case 'tg-time':
      return { type: 'date_time', text, unix_time: Number(attrs.unix), date_time_format: (attrs.format ?? 'r') as 'r' };
    case 'tg-math':
      return { type: 'mathematical_expression', expression: plainOf(text) };
    case 'tg-button':
      return { type: 'button', button: buttonFrom(attrs, text) };
    default:
      return text;
  }
}

function linkText(href: string, text: RichText): RichText {
  if (href.startsWith('#')) return { type: 'anchor_link', text, anchor_name: href.slice(1) };
  if (href.startsWith('mailto:')) return { type: 'email_address', text, email_address: href.slice(7) };
  if (href.startsWith('tel:')) return { type: 'phone_number', text, phone_number: href.slice(4) };
  const user = /^tg:\/\/user\?id=(\d+)/.exec(href);
  if (user) return { type: 'text_mention', text, user: { id: Number(user[1]), is_bot: false, first_name: plainOf(text) } };
  return { type: 'url', text, url: href };
}

function buttonFrom(attrs: Record<string, string>, text: RichText): RichMessageButton {
  const base = { text, ...(attrs.style ? { style: attrs.style as 'primary' } : {}) };
  switch (attrs.type) {
    case 'url':
      return { ...base, url: attrs.url ?? '' };
    case 'callback_data':
      return { ...base, callback_data: attrs.data ?? '' };
    case 'web_app':
      return { ...base, web_app: { url: attrs.url ?? '' } };
    case 'login_url':
      return { ...base, login_url: { url: attrs.url ?? '' } };
    case 'switch_inline_query':
      return { ...base, switch_inline_query: attrs.query ?? '' };
    case 'switch_inline_query_current_chat':
      return { ...base, switch_inline_query_current_chat: attrs.query ?? '' };
    case 'switch_inline_query_chosen_chat':
      return { ...base, switch_inline_query_chosen_chat: { query: attrs.query ?? '' } };
    case 'copy_text':
      return { ...base, copy_text: { text: attrs.text ?? '' } };
    case 'disabled':
      return { ...base, disabled: {} };
    default:
      throw new RichMessageError(`unsupported button type "${attrs.type ?? ''}"`);
  }
}

function textOf(nodes: HtmlNode[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : n.tag === 'br' ? '\n' : textOf(n.children))).join('');
}

function htmlBlocks(nodes: HtmlNode[], ctx: Ctx): RichBlock[] {
  const out: RichBlock[] = [];
  let inline: HtmlNode[] = [];
  const flush = () => {
    const text = inlineNodes(inline, ctx);
    if (plainOf(text).trim() || typeof text !== 'string') out.push({ type: 'paragraph', text: trimText(text) });
    inline = [];
  };
  for (const node of nodes) {
    if (typeof node === 'string' || !isBlock(node)) {
      inline.push(node);
      continue;
    }
    flush();
    out.push(...htmlBlock(node, ctx));
  }
  flush();
  return out;
}

function isBlock(node: Exclude<HtmlNode, string>): boolean {
  if (node.tag === 'img') return !/^tg:\/\/emoji/.test(node.attrs.src ?? '');
  // `<a name="…"></a>` on its own is an anchor block.
  if (node.tag === 'a') return node.attrs.href === undefined && node.attrs.name !== undefined && !textOf(node.children).trim();
  return BLOCK_TAGS.has(node.tag);
}

const MEDIA_TAG: Record<string, RichMediaKind | undefined> = { img: 'photo', 'tg-document': 'document' };

function htmlBlock(node: Exclude<HtmlNode, string>, ctx: Ctx): RichBlock[] {
  const { tag, attrs, children } = node;
  const el = (name: string) => children.filter((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag === name);
  const without = (...names: string[]) => children.filter((c) => typeof c === 'string' || !names.includes(c.tag));
  const credit = () => {
    const cite = el('cite')[0];
    return cite ? { credit: inlineNodes(cite.children, ctx) } : {};
  };
  const caption = (): RichBlockCaption | undefined => {
    const fig = el('figcaption')[0];
    if (!fig) return undefined;
    const cite = fig.children.find((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag === 'cite');
    return { text: trimText(inlineNodes(fig.children.filter((c) => c !== cite), ctx)), ...(cite ? { credit: inlineNodes(cite.children, ctx) } : {}) };
  };
  if (/^h[1-6]$/.test(tag)) return [{ type: 'heading', size: Number(tag[1]) as 1, text: trimText(inlineNodes(children, ctx)) }];
  switch (tag) {
    case 'p':
      return htmlBlocks(children, ctx);
    case 'footer':
      return [{ type: 'footer', text: trimText(inlineNodes(children, ctx)) }];
    case 'hr':
      return [{ type: 'divider' }];
    case 'a':
      return [{ type: 'anchor', name: attrs.name! }];
    case 'pre': {
      const code = el('code')[0];
      const language = /language-([\w#+.-]+)/.exec(code?.attrs.class ?? '')?.[1];
      return [{ type: 'pre', text: textOf(children).replace(/^\n/, ''), ...(language ? { language } : {}) }];
    }
    case 'tg-math-block':
      return [{ type: 'mathematical_expression', expression: textOf(children).trim() }];
    case 'blockquote':
      if ('expandable' in attrs) return [{ type: 'expandable_blockquote', text: trimText(inlineNodes(without('cite'), ctx)), ...credit() }];
      return [{ type: 'blockquote', blocks: htmlBlocks(without('cite'), ctx), ...credit() }];
    case 'aside':
      return [{ type: 'pullquote', text: trimText(inlineNodes(without('cite'), ctx)), ...credit() }];
    case 'ul':
    case 'ol':
      return [htmlList(node, ctx)];
    case 'table':
      return [htmlTable(node, ctx)];
    case 'details': {
      const summary = el('summary')[0];
      return [{ type: 'details', summary: summary ? trimText(inlineNodes(summary.children, ctx)) : '', blocks: htmlBlocks(without('summary'), ctx), ...('open' in attrs ? { is_open: true as const } : {}) }];
    }
    case 'tg-map':
      return [mapBlock(attrs)];
    case 'figure': {
      const inner = children.find((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag !== 'figcaption');
      if (!inner) return [];
      const cap = caption();
      if (inner.tag === 'tg-map') return [{ ...mapBlock(inner.attrs), ...(cap ? { caption: cap } : {}) } as RichBlock];
      return [htmlMedia(inner, ctx, cap)];
    }
    case 'tg-collage':
    case 'tg-slideshow': {
      const media = children.filter((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag !== 'figcaption').map((c) => htmlMedia(c, ctx));
      const cap = caption();
      return [{ type: tag === 'tg-collage' ? 'collage' : 'slideshow', blocks: media, ...(cap ? { caption: cap } : {}) }];
    }
    case 'tg-button-row': {
      const buttons = el('tg-button').map((b) => buttonFrom(b.attrs, trimText(inlineNodes(b.children, ctx))));
      return [{ type: 'buttons', buttons, ...(attrs.align ? { align: attrs.align as 'left' } : {}) }];
    }
    default:
      return [htmlMedia(node, ctx)];
  }
}

function htmlMedia(node: Exclude<HtmlNode, string>, ctx: Ctx, caption?: RichBlockCaption): RichBlock {
  const src = node.attrs.src ?? '';
  let kind = MEDIA_TAG[node.tag];
  if (node.tag === 'video') kind = /\.gif(?:[?#]|$)/i.test(src) ? 'animation' : 'video';
  if (node.tag === 'audio') kind = /\.(ogg|oga|opus)(?:[?#]|$)/i.test(src) ? 'voice_note' : 'audio';
  if (!kind) throw new RichMessageError(`<${node.tag}> isn't a media element`);
  return mediaBlock(kind, src, ctx, { ...(caption ? { caption } : {}), spoiler: 'tg-spoiler' in node.attrs });
}

function mapBlock(attrs: Record<string, string>): Extract<RichBlock, { type: 'map' }> {
  const zoom = Math.min(20, Math.max(13, Number(attrs.zoom ?? 15))) as 15;
  return { type: 'map', location: { latitude: Number(attrs.lat), longitude: Number(attrs.long) }, zoom, width: Number(attrs.width ?? 600), height: Number(attrs.height ?? 300) };
}

function htmlList(node: Exclude<HtmlNode, string>, ctx: Ctx): RichBlock {
  const ordered = node.tag === 'ol';
  const items = node.children.filter((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag === 'li');
  const type = (node.attrs.type ?? '1') as '1';
  const reversed = 'reversed' in node.attrs;
  let n = Number(node.attrs.start ?? (reversed ? items.length : 1));
  return {
    type: 'list',
    items: items.map((li) => {
      const box = li.children.find((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag === 'input' && c.attrs.type === 'checkbox');
      if (li.attrs.value !== undefined) n = Number(li.attrs.value);
      const itemType = (li.attrs.type ?? type) as '1';
      const label = box ? '' : ordered ? `${numberLabel(n, itemType)}.` : '•';
      const value = n;
      n += reversed ? -1 : 1;
      return {
        label,
        blocks: htmlBlocks(li.children, ctx),
        ...(box ? { has_checkbox: true as const, ...('checked' in box.attrs ? { is_checked: true as const } : {}) } : {}),
        ...(ordered ? { value, ...(itemType !== '1' ? { type: itemType } : {}) } : {}),
      };
    }),
  };
}

function numberLabel(n: number, type: 'a' | 'A' | 'i' | 'I' | '1'): string {
  if (type === 'a' || type === 'A') {
    let s = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return type === 'A' ? s.toUpperCase() : s;
  }
  if (type === 'i' || type === 'I') {
    const numerals: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    let k = n;
    for (const [v, r] of numerals) for (; k >= v; k -= v) s += r;
    return type === 'I' ? s.toUpperCase() : s;
  }
  return String(n);
}

function htmlTable(node: Exclude<HtmlNode, string>, ctx: Ctx): RichBlock {
  const rows: Exclude<HtmlNode, string>[] = [];
  const collect = (nodes: HtmlNode[]) => {
    for (const c of nodes) if (typeof c !== 'string') c.tag === 'tr' ? rows.push(c) : collect(c.children);
  };
  collect(node.children.filter((c) => typeof c === 'string' || c.tag !== 'caption'));
  const caption = node.children.find((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && c.tag === 'caption');
  const cells = rows.map((tr) =>
    tr.children
      .filter((c): c is Exclude<HtmlNode, string> => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
      .map((td): RichBlockTableCell => ({
        text: trimText(inlineNodes(td.children, ctx)),
        ...(td.tag === 'th' ? { is_header: true as const } : {}),
        ...(td.attrs.colspan ? { colspan: Number(td.attrs.colspan) } : {}),
        ...(td.attrs.rowspan ? { rowspan: Number(td.attrs.rowspan) } : {}),
        align: (td.attrs.align ?? 'left') as 'left',
        valign: (td.attrs.valign ?? 'top') as 'top',
      })),
  );
  if (cells.some((row) => row.length > 20)) throw new RichMessageError('a table can have at most 20 columns');
  return {
    type: 'table',
    cells,
    ...('bordered' in node.attrs ? { is_bordered: true as const } : {}),
    ...('striped' in node.attrs ? { is_striped: true as const } : {}),
    ...('compact' in node.attrs ? { is_compact: true as const } : {}),
    ...(caption ? { caption: trimText(inlineNodes(caption.children, ctx)) } : {}),
  };
}

/* ------------------------------ rich text utils ----------------------------- */

/** Flattens nested arrays, merges adjacent strings; one part is returned as is. */
function simplify(parts: RichText[]): RichText {
  const out: RichText[] = [];
  for (const part of parts.flat(Infinity as 1) as RichText[]) {
    if (part === '') continue;
    if (typeof part === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] = (out.at(-1) as string) + part;
    else out.push(part);
  }
  return out.length === 0 ? '' : out.length === 1 ? out[0]! : out;
}

/** Without the whitespace HTML adds around a paragraph. */
function trimText(text: RichText): RichText {
  if (typeof text === 'string') return text.trim();
  if (!Array.isArray(text)) return text;
  const parts = [...text];
  if (typeof parts[0] === 'string') parts[0] = parts[0].trimStart();
  if (typeof parts.at(-1) === 'string') parts[parts.length - 1] = (parts.at(-1) as string).trimEnd();
  return simplify(parts);
}

/** The text of rich text, without formatting. */
export function plainOf(text: RichText | undefined): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(plainOf).join('');
  switch (text.type) {
    case 'custom_emoji':
      return text.alternative_text;
    case 'mathematical_expression':
      return text.expression;
    case 'anchor':
      return '';
    case 'button':
      return `[${plainOf(text.button.text)}]`;
    default:
      return plainOf((text as { text: RichText }).text);
  }
}

function plainOfBlocks(blocks: RichBlock[], indent = ''): string {
  return blocks
    .map((b): string => {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
        case 'pre':
        case 'footer':
        case 'expandable_blockquote':
        case 'pullquote':
        case 'thinking':
          return plainOf(b.text);
        case 'divider':
          return '———';
        case 'mathematical_expression':
          return b.expression;
        case 'anchor':
          return '';
        case 'list':
          return b.items.map((item) => `${indent}${item.has_checkbox ? (item.is_checked ? '☑' : '☐') : item.label} ${plainOfBlocks(item.blocks, `${indent}  `).trimStart()}`).join('\n');
        case 'blockquote':
        case 'collage':
        case 'slideshow':
          return plainOfBlocks(b.blocks, indent);
        case 'details':
          return [plainOf(b.summary), plainOfBlocks(b.blocks, indent)].filter(Boolean).join('\n');
        case 'table':
          return b.cells.map((row) => row.map((cell) => plainOf(cell.text)).join(' | ')).join('\n');
        case 'buttons':
          return b.buttons.map((button) => `[${plainOf(button.text)}]`).join(' ');
        case 'map':
          return `📍 ${b.location.latitude}, ${b.location.longitude}`;
        default:
          return plainOf((b as { caption?: RichBlockCaption }).caption?.text) || `[${b.type.replace('_', ' ')}]`;
      }
    })
    .filter((s) => s !== '')
    .join('\n');
}

/** A rich message as plain text: one line per paragraph, list item and table row. */
export function richPlainText(rich: RichMessage): string {
  return plainOfBlocks(rich.blocks);
}

/** Every button of a rich message, in order (button blocks and buttons inside text). */
export function richButtons(rich: RichMessage | undefined): RichMessageButton[] {
  const out: RichMessageButton[] = [];
  const fromText = (text: RichText | undefined): void => {
    if (text === undefined || typeof text === 'string') return;
    if (Array.isArray(text)) return text.forEach(fromText);
    if (text.type === 'button') out.push(text.button);
    else if ('text' in text) fromText(text.text as RichText);
  };
  const fromBlocks = (blocks: RichBlock[]): void => {
    for (const b of blocks) {
      if (b.type === 'buttons') out.push(...b.buttons);
      if ('text' in b) fromText(b.text as RichText);
      if ('summary' in b) fromText(b.summary);
      if ('blocks' in b) fromBlocks(b.blocks);
      if (b.type === 'list') b.items.forEach((item) => fromBlocks(item.blocks));
      if (b.type === 'table') b.cells.flat().forEach((cell) => fromText(cell.text));
    }
  };
  if (rich) fromBlocks(rich.blocks);
  return out;
}

/* --------------------------------- display --------------------------------- */

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RichHtmlOptions {
  /** A URL a browser can show for a file id (the simulator's files). */
  fileUrl?: (fileId: string) => string | undefined;
  /** Attributes of the n-th button (in `richButtons` order), to make it pressable. */
  button?: (index: number, button: RichMessageButton) => string;
}

/** A rich message as HTML for a chat window (classes prefixed `rich-`). */
export function richHtml(rich: RichMessage, options: RichHtmlOptions = {}): string {
  let buttons = 0;
  const button = (b: RichMessageButton) => {
    const index = buttons++;
    const off = 'disabled' in b && b.disabled;
    const attrs = off ? 'disabled' : (options.button?.(index, b) ?? '');
    return `<button class="kbtn rich-btn${off ? ' off' : ''}${b.style ? ` rich-${b.style}` : ''}" ${attrs}>${text(b.text)}</button>`;
  };
  const text = (t: RichText | undefined): string => {
    if (t === undefined) return '';
    if (typeof t === 'string') return escHtml(t).replace(/\n/g, '<br>');
    if (Array.isArray(t)) return t.map(text).join('');
    switch (t.type) {
      case 'bold':
        return `<b>${text(t.text)}</b>`;
      case 'italic':
        return `<i>${text(t.text)}</i>`;
      case 'underline':
        return `<u>${text(t.text)}</u>`;
      case 'strikethrough':
        return `<s>${text(t.text)}</s>`;
      case 'spoiler':
        return `<span class="rich-spoiler">${text(t.text)}</span>`;
      case 'subscript':
        return `<sub>${text(t.text)}</sub>`;
      case 'superscript':
        return `<sup>${text(t.text)}</sup>`;
      case 'marked':
        return `<mark>${text(t.text)}</mark>`;
      case 'code':
        return `<code>${text(t.text)}</code>`;
      case 'custom_emoji':
        return escHtml(t.alternative_text);
      case 'mathematical_expression':
        return `<span class="rich-math">${escHtml(t.expression)}</span>`;
      case 'url':
        return /^(https?|tg):/i.test(t.url) ? `<a href="${escHtml(t.url)}" target="_blank" rel="noopener">${text(t.text)}</a>` : text(t.text);
      case 'email_address':
        return `<a href="mailto:${escHtml(t.email_address)}">${text(t.text)}</a>`;
      case 'phone_number':
        return `<a href="tel:${escHtml(t.phone_number)}">${text(t.text)}</a>`;
      case 'button':
        return button(t.button);
      case 'anchor':
        return '';
      case 'reference_link':
        return `<sup class="rich-ref">${text(t.text)}</sup>`;
      default:
        return `<span class="rich-link">${text((t as { text: RichText }).text)}</span>`;
    }
  };
  const caption = (c: RichBlockCaption | undefined) =>
    c ? `<div class="rich-caption">${text(c.text)}${c.credit !== undefined ? ` <cite>${text(c.credit)}</cite>` : ''}</div>` : '';
  const file = (id: string | undefined) => (id ? options.fileUrl?.(id) : undefined);
  const blocks = (list: RichBlock[]): string =>
    list
      .map((b): string => {
        switch (b.type) {
          case 'paragraph':
            return `<p>${text(b.text)}</p>`;
          case 'heading':
            return `<div class="rich-h rich-h${b.size}">${text(b.text)}</div>`;
          case 'pre':
            return `<pre>${typeof b.text === 'string' ? escHtml(b.text) : text(b.text)}</pre>`;
          case 'footer':
            return `<div class="rich-footer">${text(b.text)}</div>`;
          case 'divider':
            return '<hr>';
          case 'mathematical_expression':
            return `<div class="rich-math block">${escHtml(b.expression)}</div>`;
          case 'anchor':
            return '';
          case 'thinking':
            return `<div class="rich-thinking">${text(b.text)}</div>`;
          case 'list':
            return `<ul class="rich-list">${b.items
              .map((item) => `<li><span class="rich-label">${item.has_checkbox ? (item.is_checked ? '☑' : '☐') : escHtml(item.label)}</span><div>${blocks(item.blocks)}</div></li>`)
              .join('')}</ul>`;
          case 'blockquote':
            return `<blockquote>${blocks(b.blocks)}${b.credit !== undefined ? `<cite>${text(b.credit)}</cite>` : ''}</blockquote>`;
          case 'expandable_blockquote':
            return `<blockquote class="rich-expandable">${text(b.text)}${b.credit !== undefined ? `<cite>${text(b.credit)}</cite>` : ''}</blockquote>`;
          case 'pullquote':
            return `<blockquote class="rich-pull">${text(b.text)}${b.credit !== undefined ? `<cite>${text(b.credit)}</cite>` : ''}</blockquote>`;
          case 'details':
            return `<details${b.is_open ? ' open' : ''}><summary>${text(b.summary)}</summary>${blocks(b.blocks)}</details>`;
          case 'collage':
          case 'slideshow':
            return `<div class="rich-${b.type}">${blocks(b.blocks)}</div>${caption(b.caption)}`;
          case 'table':
            return `<div class="rich-table-wrap"><table class="rich-table${b.is_bordered ? ' bordered' : ''}${b.is_striped ? ' striped' : ''}">${b.cells
              .map(
                (row) =>
                  `<tr>${row
                    .map((cell) => {
                      const tag = cell.is_header ? 'th' : 'td';
                      const span = `${cell.colspan ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan ? ` rowspan="${cell.rowspan}"` : ''}`;
                      return `<${tag}${span} style="text-align:${cell.align};vertical-align:${cell.valign}">${text(cell.text)}</${tag}>`;
                    })
                    .join('')}</tr>`,
              )
              .join('')}</table>${b.caption !== undefined ? `<div class="rich-caption">${text(b.caption)}</div>` : ''}</div>`;
          case 'map':
            return `<div class="card">📍 <a href="https://www.openstreetmap.org/?mlat=${b.location.latitude}&mlon=${b.location.longitude}#map=${b.zoom}/${b.location.latitude}/${b.location.longitude}" target="_blank" rel="noopener">${b.location.latitude}, ${b.location.longitude}</a></div>${caption(b.caption)}`;
          case 'buttons':
            return `<div class="krow rich-buttons" style="justify-content:${b.align === 'center' ? 'center' : b.align === 'right' ? 'flex-end' : 'flex-start'}">${b.buttons.map(button).join('')}</div>`;
          case 'photo': {
            const url = file(b.photo.at(-1)?.file_id);
            return `${url ? `<img class="img${b.has_spoiler ? ' rich-blur' : ''}" src="${escHtml(url)}" alt="" loading="lazy">` : '<div class="ph"><div><span>🖼</span>photo</div></div>'}${caption(b.caption)}`;
          }
          case 'video':
          case 'animation': {
            const media = b.type === 'video' ? b.video : b.animation;
            const url = file(media.file_id);
            return `${url ? `<video class="img" src="${escHtml(url)}" ${b.type === 'animation' ? 'autoplay loop muted playsinline' : 'controls playsinline'}></video>` : `<div class="ph"><div><span>🎬</span>${b.type}</div></div>`}${caption(b.caption)}`;
          }
          case 'audio':
          case 'voice_note': {
            const media = b.type === 'audio' ? b.audio : b.voice_note;
            const url = file(media.file_id);
            return `${url ? `<audio src="${escHtml(url)}" controls style="width:100%"></audio>` : `<div class="file"><div class="icon">🎵</div><div>${b.type.replace('_', ' ')}</div></div>`}${caption(b.caption)}`;
          }
          case 'document': {
            const url = file(b.document.file_id);
            const name = escHtml(b.document.file_name ?? 'document');
            return `<div class="file"><div class="icon">📄</div><div>${url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener">${name}</a>` : name}</div></div>${caption(b.caption)}`;
          }
          default:
            return '';
        }
      })
      .join('');
  return `<div class="rich"${rich.is_rtl ? ' dir="rtl"' : ''}>${blocks(rich.blocks)}</div>`;
}
