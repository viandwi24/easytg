/**
 * Splitting long messages. Telegram limits the *visible* text: 4096
 * characters per message and 1024 per caption, counted in UTF-16 code units
 * after formatting is parsed (tags don't count, `&amp;` counts as one).
 */
export const MESSAGE_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

interface Token {
  raw: string;
  /** Visible length. */
  size: number;
  kind: 'text' | 'newline' | 'open' | 'close' | 'entity';
  /** Tag name for open/close tokens. */
  name?: string;
}

function tokenize(input: string, html: boolean): Token[] {
  const tokens: Token[] = [];
  const pattern = html ? /<\/?[a-zA-Z][^>]*>|&#?\w+;|\n|[^<&\n]+|[<&]/g : /\n|[^\n]+/g;
  for (const match of input.matchAll(pattern)) {
    const raw = match[0];
    if (raw === '\n') tokens.push({ raw, size: 1, kind: 'newline' });
    else if (html && raw.startsWith('</')) tokens.push({ raw, size: 0, kind: 'close', name: tagName(raw) });
    else if (html && raw.startsWith('<') && raw.length > 1) tokens.push({ raw, size: 0, kind: 'open', name: tagName(raw) });
    else if (html && raw.startsWith('&') && raw.length > 1) tokens.push({ raw, size: entitySize(raw), kind: 'entity' });
    else tokens.push({ raw, size: raw.length, kind: 'text' });
  }
  return tokens;
}

/** Telegram counts UTF-16 units: a numeric entity above U+FFFF (e.g. an emoji) counts as 2. */
function entitySize(entity: string) {
  const numeric = /^&#(x?)([0-9a-f]+);$/i.exec(entity);
  if (!numeric) return 1;
  return Number.parseInt(numeric[2]!, numeric[1] ? 16 : 10) > 0xffff ? 2 : 1;
}

function tagName(tag: string) {
  return /^<\/?([a-zA-Z-]+)/.exec(tag)![1]!.toLowerCase();
}

/**
 * Split text into chunks whose visible length fits the limits: `limits[0]`
 * for the first chunk, the last value for all following ones. Cuts at line
 * breaks when possible; in HTML, tags open at a cut are closed and reopened.
 * With `escapes` (MarkdownV2), a cut never separates a `\\` from the
 * character it escapes.
 */
export function splitText(input: string, html: boolean, limits: number[], escapes = false): string[] {
  const limitFor = (index: number) => limits[Math.min(index, limits.length - 1)]!;
  const chunks: string[] = [];

  let stack: Token[] = []; // open tags at the current position
  let startStack: Token[] = []; // open tags when the current chunk began
  let current: Array<{ token: Token; stackAfter: Token[] }> = [];
  let size = 0;

  const flush = (items: typeof current, openAtStart: Token[], openAtEnd: Token[]) => {
    const body = items.map((i) => i.token.raw).join('');
    const reopen = openAtStart.map((t) => t.raw).join('');
    const close = [...openAtEnd].reverse().map((t) => `</${t.name}>`).join('');
    const chunk = (reopen + body + close).replace(/^\n+|\n+$/g, '');
    // Telegram trims messages: a chunk of only spaces would be "message text is empty".
    if (hasVisibleText(chunk, html)) chunks.push(chunk);
  };

  const push = (token: Token) => {
    if (token.kind === 'open') stack = [...stack, token];
    else if (token.kind === 'close') {
      const index = stack.map((t) => t.name).lastIndexOf(token.name);
      if (index !== -1) stack = stack.slice(0, index);
    }
    current.push({ token, stackAfter: stack });
    size += token.size;
  };

  const startNewChunk = (items: typeof current, openAtStart: Token[]) => {
    current = [];
    size = 0;
    startStack = openAtStart;
    stack = openAtStart;
    for (const { token } of items) push(token);
  };

  const queue = tokenize(input, html);
  for (let i = 0; i < queue.length; i++) {
    const token = queue[i]!;
    const limit = limitFor(chunks.length);
    if (size + token.size <= limit) {
      push(token);
      continue;
    }

    // A line break that doesn't fit is the perfect place to cut.
    if (token.kind === 'newline') {
      flush(current, startStack, stack);
      startNewChunk([], stack);
      continue;
    }

    // Otherwise prefer cutting at the last line break of the current chunk.
    const breakAt = current.map((i) => i.token.kind).lastIndexOf('newline');
    if (breakAt > 0) {
      const before = current.slice(0, breakAt);
      const after = current.slice(breakAt + 1).map((item) => item.token);
      const openAtBreak = current[breakAt]!.stackAfter;
      flush(before, startStack, openAtBreak);
      startNewChunk([], openAtBreak);
      // Process the carried-over tokens (and this one) again: the next chunk may have a different limit.
      queue.splice(i, 0, ...after);
      i -= 1;
      continue;
    }

    // Still too long: a single long line. Split the text itself.
    let rest = token;
    while (size + rest.size > limitFor(chunks.length)) {
      const room = limitFor(chunks.length) - size;
      if (rest.kind !== 'text' || room <= 0) {
        flush(current, startStack, stack);
        startNewChunk([], stack);
        if (rest.kind !== 'text') break;
        continue;
      }
      let cut = cutPoint(rest.raw, room, escapes);
      if (cut === 0 && size === 0) cut = Math.min(2, rest.raw.length); // limit smaller than one character: can't do better
      if (cut === 0) {
        // Not even one character fits (e.g. an emoji with one unit left): next chunk.
        flush(current, startStack, stack);
        startNewChunk([], stack);
        continue;
      }
      push({ ...rest, raw: rest.raw.slice(0, cut), size: cut });
      flush(current, startStack, stack);
      startNewChunk([], stack);
      const remaining = rest.raw.slice(cut).replace(/^ /, '');
      rest = { ...rest, raw: remaining, size: remaining.length };
    }
    if (rest.size > 0 || rest.kind !== 'text') push(rest);
  }

  if (current.length) flush(current, startStack, stack);
  return chunks.length ? chunks : [''];
}

/** Where to cut `text` so the first part is at most `room` long: at a space if possible, never inside a surrogate pair. */
function cutPoint(text: string, room: number, escapes: boolean) {
  let cut = room;
  const space = text.lastIndexOf(' ', room);
  if (space > room * 0.6) cut = space;
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1; // don't split a surrogate pair
  if (escapes) {
    // An odd run of backslashes before the cut: the last one escapes the next character.
    let backslashes = 0;
    while (cut - backslashes - 1 >= 0 && text[cut - backslashes - 1] === '\\') backslashes++;
    if (backslashes % 2 === 1) cut -= 1;
  }
  return Math.max(0, cut);
}

function hasVisibleText(input: string, html: boolean): boolean {
  return tokenize(input, html).some((t) => t.kind === 'entity' || (t.kind === 'text' && t.raw.trim() !== ''));
}

/** Visible length as Telegram counts it. */
export function visibleLength(input: string, html: boolean): number {
  return tokenize(input, html).reduce((sum, t) => sum + t.size, 0);
}
