# Text formatting

Plain strings are parsed with the app's `parseMode`, which you can override per
content or per step:

| `parseMode` | meaning |
|---|---|
| `markdown` (default) | `**bold**` `*italic*` `_italic_` `__underline__` `~~strike~~` `\|\|spoiler\|\|` `` `code` `` ```` ```pre``` ```` `[text](url)` `> quote` `# heading` `- bullet` |
| `html` | raw Telegram HTML |
| `markdownv2` | raw Telegram MarkdownV2 |
| `markdownv1` | raw legacy Telegram Markdown (`parse_mode: 'Markdown'`) |
| `plain` | no formatting |

> **Not Telegram's Markdown.** In easytg's `markdown`, `**x**` is bold and
> `*x*` is *italic*, as in most Markdown. In Telegram's own `markdownv2` and
> `markdownv1`, `*x*` is **bold**. Texts written for Telegram's Markdown
> need `parseMode: 'markdownv2'` (or `'markdownv1'`), not the default.

The Markdown dialect is predictable:
- `_` inside words (`snake_case`, URLs) never becomes italic.
- Unmatched markers are shown as-is.
- `\` escapes the next character, except in code: inside `` `code` `` and
  code blocks, text is shown as written (only `\\` and `` \` `` are escapes),
  so `` `\d+` `` stays `\d+`.
- Code blocks take any language name: ```` ```c++ ````, ```` ```c# ````.

**Put user data in `md` / `html` templates.** They escape every interpolated
value, so a user named `[free](https://evil)` can't inject a link:

```ts
text: md`Hello **${user.name}**, you owe ${amount}`
text: html`Hello <b>${user.name}</b>`
text: [md`**${title}**`, 'a plain line follows parseMode']  // mixing is fine, in every parse mode
```

Fragments nest: `md` keeps nested `md` fragments, `html` keeps nested `md`
and `html` fragments. An `html` fragment inside `md` is escaped (its tags
show as text).

**Fragments work in every parse mode.** In `markdown`, `html` and `plain`
the message goes out as HTML. In `markdownv2` and `markdownv1` the fragments
are converted to that mode, values escaped for it, so they mix with your raw
strings:

```ts
new EasyTG({ parseMode: 'markdownv2' });
text: ['*Order* \\#42', md`for **${user.name}**`]   // → *Order* \#42\nfor *Ann\_B\.*
```

Legacy Markdown (`markdownv1`) only knows bold, italic, code, code blocks
and links, and no nesting: underline, strikethrough, spoilers and quotes in a
fragment keep their text without the formatting there.

To escape by hand: `escapeFor(parseMode, text)`, or `escapeMarkdown`,
`escapeHTML`, `escapeMarkdownV2`, `escapeMarkdownV1`. `htmlToMarkdownV2` and
`htmlToMarkdownV1` convert Telegram HTML yourself.

## One transform for every text

`transformText` rewrites every plain string before it is parsed: page text
and captions, dialogue prompts and your validation messages. It is the one
place to escape or convert text, e.g. when your texts are written in a
Markdown flavour of their own and you send `markdownv2`:

```ts
new EasyTG({
  parseMode: 'markdownv2',
  transformText: (text, { parseMode }) => convertToMarkdownV2(text),
});
```

It isn't called for `md`/`html` fragments (they are formatted already),
`parseMode: 'plain'` text, or easytg's own built-in messages (sent as plain
text).

## Entities: a message exactly as it was written

Telegram also describes formatting as `entities` (offsets and types), which
is what a received message carries. Give them to send text exactly as it was
written, bold, links and mentions included, e.g. to show a user's message
back to them:

```ts
page('preview').render(({ session }) => {
  const draft = session.get<{ text: string; entities?: MessageEntity[] }>('draft')!;
  return { text: draft.text, entities: draft.entities, keyboard: [[nav.button('✅ Send', confirm)]] };
});
```

The text must be plain strings and fit one message (or one caption, under
media): entity offsets point into the whole text, so it can't be split.
`parseMode` doesn't apply. A [`collect`](dialogues.md) step keeps the
entities of what it receives.

For headings, tables, task lists, formulas and pictures in one message, see
[Rich messages](rich-messages.md): `rich` instead of `text`, in Telegram's
Rich Markdown (GitHub-style, so `__x__` is bold there). `md` fragments work
there too, escaping their values for it (`escapeRichMarkdown`).

## Try it

A whole bot. On the [docs site](https://viandwi24.github.io/easytg/) it runs next to the code, in a Telegram simulator.

```ts playground
import { Bot } from 'grammy';
import { EasyTG, html, md, page } from 'easytg';

const home = page('home').render(({ ctx }) => ({
  text: [
    '**bold** *italic* __underline__ ~~strike~~ ||spoiler|| `code`',
    '> a quote',
    '```ts\nconst answer = 42;\n```',
    md`Hello **${ctx.from?.first_name ?? 'you'}** (escaped: ${'*not bold*'})`,
    html`<i>An html fragment</i> with a <a href="https://grammy.dev">link</a>`,
  ],
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(home);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.start();
```
