<div align="center">

# easytg

**Build Telegram bot interfaces like pages, not message handlers.**

Menus, forms and navigation on top of [grammY](https://grammy.dev). Define a screen once and easytg sends, replies or edits it in place.

[![npm](https://img.shields.io/npm/v/easytg.svg)](https://www.npmjs.com/package/easytg)
[![CI](https://github.com/viandwi24/easytg/actions/workflows/ci.yml/badge.svg)](https://github.com/viandwi24/easytg/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/easytg.svg)](LICENSE)

[Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [Examples](docs/README.md#examples)

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

- 🧭 **Pages & navigation.** Describe screens, not API calls. Send, reply, edit, media swaps and long-text splitting are handled for you. `nav.back()` remembers where the user came from, and `{ mode: 'send' }` keeps a message (like a video) instead of replacing it.
- ⌨️ **Both keyboards.** Inline buttons on pages, plus a main menu on the reply keyboard (`replyMenu`) with its own close button.
- 🖼 **Media.** Photos, videos, GIFs, documents, audio, albums and copies of existing messages, with optional `protectContent`.
- 🔒 **Type-safe links.** `nav.button('Open', order, { id })` fails to compile if a param is missing or misspelled, even when pages link to each other in cycles.
- 📝 **Dialogues.** Multi-step forms with answers typed from the steps, validation (or zod/valibot schemas), choices, file uploads, phone number, location and Mini App input, conditional steps, Back/Cancel and timeouts.
- 📱 **Mini Apps.** Buttons that open them, `initData` checks, acting for the user from your server, answering into the chat and sharing.
- 🔎 **Text input on pages.** `page.onText` turns a page into a search box or any other typed input.
- 🛡️ **Secure by default.** Escaping `md`/`html` templates, signed or stored tamper-proof button params, params validation with `.params(parse)` or any Standard Schema, owner-only group menus (or `allowedUsers`), admin-only pages, and anti-spam with events.
- 🌍 **Languages.** Your messages with `t('cart.items', { count })`: placeholders, plural rules, fallbacks and escaping; `setLocale` for language pickers, remembered for notifications.
- 💾 **Sessions and storage.** State per user in a chat, per user across chats, and per chat; saved once per update, typed keys, TTLs and migrations. Built-in `MemoryStorage`, `SqliteStorage` and `RedisStorage`, or any database behind a 3-method interface.
- ⏰ **Scheduled tasks and queues.** Persistent `task()`s with retries and recurring runs, `deleteLater` / `sendLater` / `broadcastLater`, self-refreshing pages, and concurrency-limited queues for slow jobs.
- 💳 **Payments.** `invoice` pages for Telegram Stars, checkout checks and a success handler.
- 🚀 **Production-ready.** Per-user ordering of concurrent updates, loading indicators for slow pages, a throttle that keeps sends within Telegram's limits, and `cluster` mode sharing rate limits, locks, queues and throttling across processes (Redis/SQLite).
- 🔗 **Deep links, inline mode, notifications, broadcasts.** `t.me/bot?start=…` links, pages as inline results, `sendTo` and `app.edit` from cron jobs and webhooks, paced `broadcast` to thousands of users, `autoRetry` for rate limits.
- 📊 **Events** for analytics and monitoring: `update` (with timings), `pageView`, `sent`, dialogue events, `spam`, `error`, `payment`, `queueWait`, `taskError`, `broadcastBatch`, `webAppData`.
- 🤖 **Multi-bot ready.** One app instance can serve several bots sharing one storage; sessions, buttons and rate limits stay per bot.
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
| **`page(id).render(fn)`** | A screen. `render` returns `{ text, photo, keyboard }`, a redirect, or a dialogue to start. Pages can also validate params (`.params`), show a loading indicator (`.loading`) and take typed text (`.onText`). |
| **`nav`** | Builds buttons and navigation: `nav.button`, `nav.self`, `nav.back`, `nav.home`, `nav.close`, `nav.url`, `nav.webApp`, `nav.pay`, `nav.deepLink`, and the render results `nav.redirect` / `nav.startDialogue`. |
| **`replyMenu([...])`** | A main menu on the reply keyboard; its buttons open pages or start dialogues. |
| **`dialogue(id).steps([...])`** | A multi-step form. Answers arrive in `onFinish`, typed from the steps. |
| **`session`** | State of the user in this chat; `app.userSession(ctx)` follows the user into every chat, `app.chatSession(ctx)` is shared by a chat. All saved automatically. |
| **Middlewares** | Run before every page and dialogue, for login checks, admin-only screens and logging. |
| **`app.open(ctx, page)`** | Shows a page: edits the message when a button was pressed, replies otherwise. |
| **`app.sendTo` / `app.edit` / `app.broadcast`** | Send or update pages without an incoming update: notifications, status cards, newsletters. |
| **`task(id).run(fn)`** | A job that runs later (`app.schedule`), saved in storage so it survives restarts. |

```ts
// A dialogue in a nutshell
const signup = dialogue('signup')
  .steps([
    { id: 'name', type: 'text', text: 'Your name?', validate: (v) => v.length >= 2 || 'Too short' },
    { id: 'plan', type: 'choice', text: 'Plan?', options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
  ])
  // answers: { name: string; plan: 'free' | 'pro' }, read off the steps
  .onFinish(({ answers }) => ({ text: md`Welcome, ${answers.name}! Plan: ${answers.plan}` }));
```

## Examples

| Example | Shows |
|---|---|
| [`getting-started.ts`](examples/getting-started.ts) | The shop bot from the getting-started guide |
| [`shop.ts`](examples/shop.ts) | Reply-keyboard menu, catalog with pagination and Back, album gallery, checkout with size, phone number and location |
| [`media.ts`](examples/media.ts) | Photo, video, GIF, document (generated), audio and album pages |
| [`search.ts`](examples/search.ts) | A searchable catalog with `page.onText`, in two languages with `t()` |
| [`course.ts`](examples/course.ts) | Members-only videos copied from a storage channel with `protectContent`, access requests approved by an admin, `app.edit`, videos that delete themselves (`deleteAfterMs`) |
| [`reminders.ts`](examples/reminders.ts) | Reminders that survive restarts: scheduled and recurring tasks in SQLite |
| [`queue.ts`](examples/queue.ts) | Slow AI-style jobs behind a queue: concurrency, one job per user, place in line |
| [`payments.ts`](examples/payments.ts) | A Telegram Stars shop: invoices, stock check at checkout, delivery, refunds |
| [`inline.ts`](examples/inline.ts) | Product pages shared with `@yourbot query`, params checked by a schema, cached photo file ids |
| [`mini-app.ts`](examples/mini-app.ts) | A bot and its Mini App in one file: a shop with a checked server API, a color picker step, feedback, sharing |
| [`sessions.ts`](examples/sessions.ts) | State per chat, per user across chats, and per group, side by side |
| [`loading.ts`](examples/loading.ts) | Slow pages with placeholders, "typing…" and toasts that only show when needed |
| [`throttle.ts`](examples/throttle.ts) | Keeping sends within Telegram's limits, with rules per chat |
| [`group.ts`](examples/group.ts) | A group bot: admin-only settings, a self-refreshing scoreboard, a quiz with a timeout |
| [`production.ts`](examples/production.ts) | Redis or SQLite, several processes with `cluster`, webhooks |
| [`broadcast.ts`](examples/broadcast.ts) | Newsletter: subscriptions, admin-only compose dialogue, a background broadcast with live progress, `broadcastLater`, events |
| [`captcha.ts`](examples/captcha.ts) | Button and typed captchas, server-side answers, per-key TTL |
| [`notify.ts`](examples/notify.ts) | SQLite storage, tamper-proof buttons, `sendLater` notifications that survive restarts |
| [`locales/id.ts`](examples/locales/id.ts) | Translating the built-in texts |
| [`testing.test.ts`](examples/testing.test.ts) | Testing a bot with `easytg/testing`: navigation, dialogues, errors, broadcasts |

```bash
BOT_TOKEN=123:abc bun run examples/captcha.ts
```

## Documentation

- **[Getting started](docs/getting-started.md)**: a hands-on tutorial.
- **[Documentation](docs/README.md)**: one page per feature.
  - UI: [Pages](docs/pages.md) · [Media](docs/media.md) · [Main menu](docs/menu.md) · [Dialogues](docs/dialogues.md) · [Text input](docs/text-input.md) · [Text formatting](docs/formatting.md) · [Languages](docs/i18n.md) · [Inline mode](docs/inline-mode.md) · [Mini Apps](docs/mini-apps.md) · [Groups](docs/groups.md)
  - Data: [Sessions](docs/sessions.md) · [Storage](docs/storage.md) · [Button params](docs/button-params.md) · [Deep links](docs/deep-links.md)
  - Beyond one update: [Notifications & broadcast](docs/proactive.md) · [Scheduled tasks](docs/scheduler.md) · [Queues](docs/queues.md) · [Payments](docs/payments.md)
  - Production: [Anti-spam](docs/anti-spam.md) · [Scaling](docs/scaling.md) · [Security](docs/security.md) · [Events](docs/events.md) · [Error helpers](docs/errors.md) · [All options](docs/options.md) · [Testing](docs/testing.md)
- **[API reference](docs/app.md)**: every export and `app` method.
- **[Migrating](docs/migration.md)**: breaking changes and how to update.
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
