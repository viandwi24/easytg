/**
 * Telegram HTML (what `md` and `html` fragments hold) to Telegram's
 * MarkdownV2 and legacy Markdown, so the safe fragments work in every parse
 * mode. Only Telegram's tags carry formatting; anything else keeps its text.
 */

/** Escape text for the `markdownv2` parse mode. */
export function escapeMarkdownV2(text: string): string {
  return String(text).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Escape text for the `markdownv1` parse mode (Telegram's legacy Markdown), outside entities. */
export function escapeMarkdownV1(text: string): string {
  return String(text).replace(/[_*`\[]/g, '\\$&');
}

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = string | Element;

const VOID = new Set(['br']);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** A forgiving parser: unknown tags are kept (their text shows), unmatched closing tags are ignored. */
function parse(html: string): Node[] {
  const root: Element = { tag: '', attrs: {}, children: [] };
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+|<)/g)) {
    const top = stack.at(-1)!;
    if (m[4] !== undefined) {
      top.children.push(decodeEntities(m[4]));
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      const index = stack.map((e) => e.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const element: Element = { tag, attrs: parseAttrs(m[3]!), children: [] };
    top.children.push(element);
    if (!VOID.has(tag) && !m[3]!.trimEnd().endsWith('/')) stack.push(element);
  }
  return root.children;
}

type Style = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'link' | 'quote' | 'emoji' | 'break' | null;

function styleOf(element: Element): Style {
  switch (element.tag) {
    case 'b':
    case 'strong':
      return 'bold';
    case 'i':
    case 'em':
      return 'italic';
    case 'u':
    case 'ins':
      return 'underline';
    case 's':
    case 'strike':
    case 'del':
      return 'strike';
    case 'tg-spoiler':
      return 'spoiler';
    case 'span':
      return element.attrs.class?.split(/\s+/).includes('tg-spoiler') ? 'spoiler' : null;
    case 'code':
      return 'code';
    case 'pre':
      return 'pre';
    case 'a':
      return 'link';
    case 'blockquote':
      return 'quote';
    case 'tg-emoji':
      return 'emoji';
    case 'br':
      return 'break';
    default:
      return null;
  }
}

function textOf(nodes: Node[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : textOf(n.children))).join('');
}

/** `<pre><code class="language-x">`: the language. */
function languageOf(pre: Element): string {
  const code = pre.children.find((c): c is Element => typeof c !== 'string' && c.tag === 'code');
  return /(?:^|\s)language-([\w#+.-]+)/.exec(code?.attrs.class ?? '')?.[1] ?? '';
}

/** Concatenate, keeping `_` (italic) and `__` (underline) markers apart, as MarkdownV2 asks. */
function joinV2(parts: string[]): string {
  let out = '';
  for (const part of parts) out += out.endsWith('_') && part.startsWith('_') ? `\r${part}` : part;
  return out;
}

/** Telegram HTML to MarkdownV2. */
export function htmlToMarkdownV2(html: string): string {
  const render = (nodes: Node[]): string => joinV2(nodes.map(node));
  const wrap = (marker: string, inner: string, close = marker) => (inner ? joinV2([marker, inner, close]) : '');
  const node = (n: Node): string => {
    if (typeof n === 'string') return escapeMarkdownV2(n);
    const inner = () => render(n.children);
    switch (styleOf(n)) {
      case 'bold':
        return wrap('*', inner());
      case 'italic':
        return wrap('_', inner());
      case 'underline':
        return wrap('__', inner());
      case 'strike':
        return wrap('~', inner());
      case 'spoiler':
        return wrap('||', inner());
      case 'code': {
        const code = textOf(n.children);
        return code ? `\`${code.replace(/[`\\]/g, '\\$&')}\`` : '';
      }
      case 'pre': {
        const code = textOf(n.children).replace(/[`\\]/g, '\\$&');
        return `\`\`\`${languageOf(n)}\n${code}\n\`\`\``;
      }
      case 'link': {
        const url = n.attrs.href ?? '';
        return url ? `[${inner()}](${url.replace(/[)\\]/g, '\\$&')})` : inner();
      }
      case 'emoji': {
        const id = n.attrs['emoji-id'];
        return id ? `![${inner()}](tg://emoji?id=${id})` : inner();
      }
      case 'quote': {
        const lines = inner().split('\n');
        if (!('expandable' in n.attrs)) return lines.map((line) => `>${line}`).join('\n');
        return lines.map((line, i) => `${i === 0 ? '**>' : '>'}${line}${i === lines.length - 1 ? '||' : ''}`).join('\n');
      }
      case 'break':
        return '\n';
      default:
        return inner();
    }
  };
  return render(parse(html));
}

/**
 * Telegram HTML to legacy Markdown. It knows only bold, italic, code, pre and
 * links, without nesting: underline, strikethrough, spoilers and quotes keep
 * their text without the formatting, and a style inside another one is dropped.
 */
export function htmlToMarkdownV1(html: string): string {
  // Inside an entity nothing can be escaped: its own marker closes it, is escaped outside, and reopens it.
  const render = (nodes: Node[], marker: string | null): string => nodes.map((n) => node(n, marker)).join('');
  const node = (n: Node, marker: string | null): string => {
    if (typeof n === 'string') {
      if (marker === null) return escapeMarkdownV1(n);
      return n.split(marker).join(`${marker}\\${marker}${marker}`);
    }
    const style = styleOf(n);
    if (marker !== null) return style === 'break' ? '\n' : render(n.children, marker); // no nesting in legacy Markdown
    const wrap = (m: string) => {
      const inner = render(n.children, m);
      // Text starting or ending with the marker leaves an empty entity (`**`): dropped.
      const empty = new RegExp(`(?<!\\\\)\\${m}\\${m}`, 'g');
      return inner ? `${m}${inner}${m}`.replace(empty, '') : '';
    };
    switch (style) {
      case 'bold':
        return wrap('*');
      case 'italic':
        return wrap('_');
      case 'code': {
        // A backtick can't be escaped inside code: it becomes a look-alike.
        const code = textOf(n.children).replace(/`/g, '\u02cb');
        return code ? `\`${code}\`` : '';
      }
      case 'pre':
        return `\`\`\`\n${textOf(n.children).replace(/`/g, '\u02cb')}\n\`\`\``;
      case 'link': {
        const url = (n.attrs.href ?? '').replace(/\)/g, '%29');
        const text = textOf(n.children);
        // "]" would end the link text, and nothing inside it can be escaped.
        if (!url || text.includes(']')) return render(n.children, null);
        return `[${text}](${url})`;
      }
      case 'break':
        return '\n';
      default:
        return render(n.children, null);
    }
  };
  return render(parse(html), null);
}
