# Rich messages

A rich message (Bot API 10.3) is one message with headings, lists, task
lists, tables, quotes, collapsible details, code, formulas, footnotes,
pictures, videos, maps and buttons inside the text. Where a text page needs
several messages or a picture plus a caption, a rich page needs one. Return
`rich` instead of `text`:

```ts
const report = page('report').render(({ nav }) => ({
  rich: [
    '# Weekly report',
    '',
    '| Metric | Value |',
    '|:-------|------:|',
    '| Orders | **128** |',
    '| Refunds | 3 |',
    '',
    '- [x] Ship the new checkout',
    '- [ ] Fix the search',
  ],
  keyboard: [[nav.button('Details', details)], [nav.back()]],
}));
```

`rich` takes three forms:

| | |
|---|---|
| a string, `md` fragments, or an array of them (joined with newlines) | Telegram's **Rich Markdown**, GitHub-style: `# headings`, `**bold**`, `*italic*`, `~~strike~~`, `==marked==`, `\|\|spoiler\|\|`, `` `code` ``, fenced code, `> quotes`, lists, `- [ ]` tasks, tables, `---`, `$x^2$` and `$$…$$` formulas, `[^1]` footnotes, `![](https://…/photo.jpg "caption")`, and HTML tags for the rest |
| one `html` fragment | **Rich HTML**: `<h1>`, `<p>`, `<ul>`, `<table>`, `<details>`, `<blockquote>`, `<figure>`, `<tg-map>`, `<tg-button>`, … |
| `{ markdown }`, `{ html }` or `{ blocks }` | the Bot API's `InputRichMessage` as it is, with `media`, `is_rtl` or `skip_entity_detection` |

Telegram's [rich message formatting](https://core.telegram.org/bots/api#inputrichmessage)
lists every tag. Separate paragraphs with an empty line, as in any Markdown.

## User input

As with text, the `md` template escapes what you interpolate, for Rich
Markdown too: a name like `# Bob | *x*` can't become a heading, a table
column, a formula or a link. A table from data stays a table:

```ts
rich: [
  '| Plan | Price |',
  '|---|--:|',
  ...plans.map((p) => md`| ${p.name} | ${p.price} |`),
],
```

`escapeRichMarkdown(text)` does the same for strings you build yourself, and
`html` escapes for Rich HTML. Translations work too: `t.md(key, vars)`.

## Delivery

- A rich page edits a text or rich message in place, and a text page edits a
  rich message in place. Between rich and media messages (photos, videos…)
  the pressed message is replaced by a new one: Telegram can't edit one into
  the other.
- `keyboard` works as on any page. Buttons can also go inside the text:
  `<tg-button type="callback_data" data="${nav.data(page)}">Open</tg-button>`
  (or a `buttons` block) opens a page like `nav.button`.
- Ephemeral pages, `sendTo`, `app.edit` and inline results can be rich.
  Inline results can't upload files: their media must already be on
  Telegram.
- A rich message holds up to 32768 characters and 50 media; it isn't split
  like long text. `rich` can't be combined with `text` or media fields, since
  the media goes inside the message.
- [`app.stream(…, { rich: true })`](streaming.md#rich-answers) streams an AI
  answer as a rich draft and sends it as a rich message.

## Try it

[`examples/rich.ts`](../examples/rich.ts) is a handbook with a table,
collapsible answers, a button inside the text and a page built from blocks.

```ts playground
import { Bot } from 'grammy';
import { EasyTG, html, md, page } from 'easytg';

const plans = [
  { name: 'Starter', price: 'free' },
  { name: 'Team | Pro', price: '$12/mo' }, // the | is escaped by md``
];

const home = page('home').render(({ ctx, nav }) => ({
  rich: [
    md`# Hi ${ctx.from?.first_name ?? 'there'}!`,
    '',
    '| Plan | Price |',
    '|:-----|------:|',
    ...plans.map((p) => md`| **${p.name}** | ${p.price} |`),
    '',
    '- [x] Tables, lists and **formatting**',
    '- [ ] Your content here',
    '',
    '$$E = mc^2$$',
  ],
  keyboard: [[nav.button('❓ FAQ', faq)]],
}));

const faq = page('faq').render(({ nav }) => ({
  rich: html`<h2>FAQ</h2>
<details open><summary>Is this one message?</summary><p>Yes: headings, tables and answers that open, all in one.</p></details>
<details><summary>Can it have buttons?</summary><p>Under it and inside it: <tg-button type="callback_data" data="${nav.data(home)}">Back home</tg-button></p></details>`,
  keyboard: [[nav.back()]],
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(faq).command('start', home);
bot.use(app);
bot.start();
```

The [simulator](simulator.md#rich-messages) shows rich messages and checks
them like Telegram, closely but not with Telegram's own parser: test on
Telegram before relying on an unusual construct.
