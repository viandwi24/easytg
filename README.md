<div align="center">

# easytg

**Build Telegram bot interfaces like pages, not message handlers.**

Menus, forms and navigation on top of [grammY](https://grammy.dev). Define a screen once and easytg sends, replies or edits it in place.

[![npm](https://img.shields.io/npm/v/easytg.svg)](https://www.npmjs.com/package/easytg)
[![CI](https://github.com/viandwi24/easytg/actions/workflows/ci.yml/badge.svg)](https://github.com/viandwi24/easytg/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/easytg.svg)](LICENSE)

[Getting started](docs/getting-started.md) · [Guide](docs/guide.md) · [Examples](examples)

</div>

---

## Why easytg?

With the plain Bot API, one screen means a command handler that *sends* it, a
callback handler that *edits* it, answering the callback query, packing state
into 64-byte `callback_data`, and escaping every user-provided string. easytg
takes care of that plumbing.

<table>
<tr><th>grammY only</th><th>with easytg</th></tr>
<tr><td>

```ts
bot.command('start', (ctx) =>
  ctx.reply(`Hi <b>${escape(ctx.from.first_name)}</b>`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('Order #42', 'order:42'),
  }));

bot.callbackQuery(/^order:(.+)$/, async (ctx) => {
  const id = ctx.match[1]; // unchecked string
  await ctx.editMessageText(`Order <b>${escape(id)}</b>`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('Back', 'home'),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('home', async (ctx) => {
  // …the start screen again, as an edit this time
});
```

</td><td>

```ts
const home = page('home').render(({ ctx, nav }) => ({
  text: md`Hi **${ctx.from?.first_name}**`,
  keyboard: [[nav.button('Order #42', order, { id: '42' })]],
}));

const order = page<{ id: string }>('order').render(({ params, nav }) => ({
  text: md`Order **${params.id}**`,
  keyboard: [[nav.button('Back', home)]],
}));

const app = new EasyTG().register(home, order);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
```

</td></tr>
</table>

## Features

- 🧭 **Pages & navigation.** Describe screens, not API calls. Send, reply, edit, text ↔ photo and long-text splitting are handled for you.
- 🔒 **Type-safe links.** `nav.button('Open', order, { id })` fails to compile if a param is missing or misspelled, even when pages link to each other in cycles.
- 📝 **Dialogues.** Multi-step forms with validation, choices, file uploads, Back/Cancel and dynamic steps.
- 🛡️ **Secure by default.** Escaping `md`/`html` templates, optional tamper-proof button params, owner-only group menus, and anti-spam with events.
- 💾 **Sessions** per user, saved once per update, with per-key and session TTLs. Any database fits the 3-method `StorageAdapter`.
- 🔗 **Deep links, notifications, i18n.** `t.me/bot?start=…` links, `sendTo` from cron jobs and webhooks, and per-user language for built-in texts.
- 🧪 **Testable.** `easytg/testing` runs your bot against a fake Telegram API, with no token and no network.
- 🪶 **Zero dependencies.** grammY is the only peer dependency. Bun first, works on Node ≥ 18.

## Install

```bash
bun add easytg grammy
```

```bash
npm install easytg grammy
```

## Quick start

```ts
import { Bot } from 'grammy';
import { EasyTG, md, page } from 'easytg';

const home = page('home').render(({ ctx, nav }) => ({
  text: md`Hello **${ctx.from?.first_name}**!`,
  keyboard: [[nav.button('👋 About', about)], [nav.close()]],
}));

const about = page('about').render(({ nav }) => ({
  text: 'Built with **easytg**.',
  keyboard: [[nav.button('⬅️ Back', home)]],
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(home, about);

bot.use(app); // register before your other handlers
bot.command('start', (ctx) => app.open(ctx, home));
bot.start();
```

Next, **[Getting started](docs/getting-started.md)** walks through building a small shop bot with pages, a form and sessions in about ten minutes.

## Core concepts

| | |
|---|---|
| **`page(id).render(fn)`** | A screen. `render` returns `{ text, photo, keyboard }`, a redirect, or a dialogue to start. |
| **`nav`** | Builds buttons and navigation: `nav.button`, `nav.self`, `nav.home`, `nav.close`, `nav.redirect`, `nav.deepLink`. |
| **`dialogue(id).steps([...])`** | A multi-step form. Answers arrive typed in `onFinish`. |
| **`session`** | Key/value state per user and chat, saved automatically. |
| **Middlewares** | Run before every page and dialogue, for login checks, admin-only screens and logging. |
| **`app.open(ctx, page)`** | Shows a page: edits the message when a button was pressed, replies otherwise. |

```ts
// A dialogue in a nutshell
const signup = dialogue<{ name: string; plan: string }>('signup')
  .steps([
    { id: 'name', type: 'text', text: 'Your name?', validate: (v) => v.length >= 2 || 'Too short' },
    { id: 'plan', type: 'choice', text: 'Plan?', options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
  ])
  .onFinish(({ answers }) => ({ text: md`Welcome, ${answers.name}!` }));
```

## Examples

| Example | Shows |
|---|---|
| [`getting-started.ts`](examples/getting-started.ts) | The shop bot from the getting-started guide |
| [`captcha.ts`](examples/captcha.ts) | Button and typed captchas, server-side answers, per-key TTL |
| [`notify.ts`](examples/notify.ts) | SQLite storage, tamper-proof buttons, `sendTo` notifications |
| [`storage/sqlite.ts`](examples/storage/sqlite.ts) | A complete `StorageAdapter` |
| [`locales/id.ts`](examples/locales/id.ts) | Translating the built-in texts |

```bash
BOT_TOKEN=123:abc bun run examples/captcha.ts
```

## Documentation

- **[Getting started](docs/getting-started.md)**: a hands-on tutorial.
- **[Guide](docs/guide.md)**: the full reference.
  - [Pages](docs/guide.md#pages) · [Dialogues](docs/guide.md#dialogues) · [Text formatting](docs/guide.md#text-formatting) · [Sessions](docs/guide.md#sessions)
  - [Middlewares](docs/guide.md#middlewares) · [Anti-spam](docs/guide.md#anti-spam) · [Events](docs/guide.md#events) · [Deep links](docs/guide.md#deep-links)
  - [Languages](docs/guide.md#languages) · [Notifications (`sendTo`)](docs/guide.md#sending-without-an-update) · [Storage](docs/guide.md#storage) · [Security](docs/guide.md#security-notes)
  - [All options](docs/guide.md#options) · [Testing](docs/guide.md#testing-your-bot)
- **[Changelog](CHANGELOG.md)**

## Requirements

- [grammY](https://grammy.dev) ≥ 1.30
- [Bun](https://bun.sh) or Node.js ≥ 18
- TypeScript is optional but recommended: it type-checks navigation.

## Contributing

Issues and pull requests are welcome.

```bash
bun install
bun test            # unit and integration tests (fake Telegram API)
bun run typecheck
bun run build
```

Releases are automated. See [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE) © viandwi24
