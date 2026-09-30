# Simulator

`easytg/simulator` is a Telegram that lives in memory: a Bot API your grammY
bot talks to, and simulated users who send messages, press buttons, pay and
use inline mode. Nothing is sent to Telegram and no token is needed. It runs
in Bun, Node, Deno and browsers; the [playground](https://viandwi24.github.io/easytg/playground)
on the docs site is this simulator with a chat window on top.

To run your bot's own file in it, with a chat window, use
[`easytg preview`](preview.md); to test that file, `loadBot` (same page).

Use it for tests that read like a conversation, for trying a bot before it
has a token, and for demos.

```ts
import { Bot } from 'grammy';
import { EasyTG, page } from 'easytg';
import { TelegramSimulator } from 'easytg/simulator';

const sim = new TelegramSimulator();
const bot = new Bot(sim.token);
sim.connect(bot);                 // or: const bot = sim.createBot();

const home = page('home').render(({ nav }) => ({ text: 'Home', keyboard: [[nav.button('Next', next)]] }));
const next = page('next').render(({ nav }) => ({ text: 'Next page', keyboard: [[nav.back()]] }));
const app = new EasyTG().register(home, next);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));

await sim.send('/start');                          // the default user, in their private chat
const menu = sim.last()!;                          // { message, fromBot, media? }
await sim.press(menu.message.message_id, 'Next');  // by text, callback data, [row, column] or the button
sim.last()!.message.text;                          // 'Next page': the same message, edited
```

Each action resolves once the bot has handled the update, so the next line
sees the result. Messages are Bot API `Message` objects (`text`, `entities`,
`reply_markup`, `edit_date`, …), kept in chat order: an edit changes the
message in place, a delete removes it.

## Users and chats

```ts
const alice = sim.user;                                   // the first user (id 1001, "You"); options.user changes it
const bob = sim.addUser({ first_name: 'Bob', language_code: 'id' });
const group = sim.createGroup({ title: 'Team', members: [alice.id, bob.id], admins: [bob.id] });

await sim.send('/quiz', { chat: group.id, user: bob.id });
sim.messages(group.id);                                   // what the group shows
sim.chat(alice.id)?.replyKeyboard;                        // the reply keyboard the bot shows Alice
```

The first member creates a group and the bot is one of its admins. Groups
see every message (as with privacy mode off).

## What users can do

| | |
|---|---|
| `send(text, { user?, chat?, replyTo? })` | a text message; `/commands`, links and mentions get their entities |
| `press(messageId, button, { user?, chat?, inlineMessageId? })` | an inline button; resolves with the answer: `{ text, alert, url }` |
| `pressReply(button, options?)` | a reply-keyboard button: text, `request_contact`, `request_location` |
| `sendMedia(kind, { url?, name?, caption? }, options?)` | a photo, document, video… |
| `sendContact(contact?, options?)` / `sendLocation(lat, lon, options?)` | contact (their own by default) and location |
| `sendWebAppData(data, buttonText, options?)` | what a Mini App sends with `Telegram.WebApp.sendData` |
| `editMessage(messageId, text, options?)` | edit one of their messages (an `edited_message` update) |
| `inlineQuery(query, { user?, chatType? })` | type `@bot query`; resolves with the bot's results |
| `chooseInlineResult(result, query, options?)` | send a result into a chat, "via @bot"; its buttons keep working |
| `pay(messageId, options?)` | pay an invoice: pre-checkout, then `successful_payment` |
| `join(chatId, userId)` / `leave(chatId, userId)` | join or leave a group |
| `block(userId?, blocked?)` | block the bot: sending to them fails with 403 |
| `tap(label, options?)` | the newest button with this label: inline, else on the reply keyboard |
| `update(raw)` | any other update |

## Answers and errors like Telegram's

The simulator answers the Bot API methods bots use (sending and editing every
kind of message, albums, deleting, copying and forwarding, callback, inline
and pre-checkout answers, chat actions, members and admins, commands, …) and
fails where Telegram fails, with Telegram's descriptions:

- `Bad Request: can't parse entities: …` for broken HTML or MarkdownV2 (the
  text is parsed into entities, like Telegram does);
- `Bad Request: message is not modified: …` for an edit that changes nothing;
- `Bad Request: message to edit not found`, `message is too long`,
  `message caption is too long`, `BUTTON_DATA_INVALID` (callback data over 64
  bytes), `query is too old…` (a callback query answered twice);
- `Forbidden: bot was blocked by the user` after `block()`, and
  `Forbidden: bot can't initiate conversation with a user` for users who never
  wrote to the bot.

An edit without `reply_markup` removes the inline keyboard, and a chat action
("typing…") lasts 5 seconds or until the next message, as in Telegram.

## Commands, notes and files

- `sim.commandsFor(chatId?, userId?)` is the command menu a user sees in a
  chat, picked from the `setMyCommands` lists like Telegram does (the chat's
  own, private chats or groups, then the default; in the user's language if
  there is a list for it). `sim.commands` is the default list.
- `sim.notice(text, chatId?)` puts a note in the chat that isn't a message
  ("🔄 Restarted"); the bot never sees it.
- Files the bot uploads are kept: `getFile` and `/file/bot…/<path>` return
  them. `new TelegramSimulator({ storeFile })` decides the URL a chat window
  shows them at (default: an object URL in browsers).

## Over HTTP

`sim.handleRequest(request)` is the Bot API as a fetch handler:
`POST /bot<token>/<method>` with JSON, form or multipart bodies (files
included, gzip too) and `/file/bot<token>/<path>` downloads. Serve it and a
bot in another process can use it (`new Bot(token, { client: { apiRoot } })`),
or route a bot's calls to it with `interceptBotApi` from
`easytg/simulator/load`. Updates then go out through `getUpdates`;
`sim.waitForPolling()` resolves once a bot asks for them.

## Watching

```ts
sim.on('change', ({ chatId }) => redraw(chatId));        // messages, keyboards, chat actions, members
sim.on('toast', ({ text, alert }) => show(text, alert));  // answerCallbackQuery with a text
sim.on('open', ({ url, kind }) => open(url));             // url, Mini App and login buttons
sim.on('call', ({ method, payload, result, error }) => log(method)); // every Bot API call
sim.on('error', ({ error }) => console.error(error));     // a handler threw (without bot.catch)
sim.calls;                                                 // the last 200 calls
```

`new TelegramSimulator({ latencyMs: 300 })` delays every API call, to see
loading indicators. `sim.clearHistory(chatId?)` empties one chat like
Telegram's "Clear history" (the bot isn't told), and `sim.reset()` forgets
all chats.

## `bot.start()`

A bot that polls works too: while `bot.isRunning()`, updates are handed out
through `getUpdates` instead of `bot.handleUpdate`, and actions resolve
once grammY has handled them (it confirms updates when it asks for the next
ones). This is how the playground runs unchanged example files.

## A chat window

`easytg/simulator/element` is a Telegram-like chat for the browser: bubbles
with formatting, inline and reply keyboards, toasts and alerts, photos and
albums, invoices, inline results, the command menu (from `setMyCommands`),
attachments, a chat and user picker when there are several, "Clear history"
in the ⋮ menu, and a START button in an empty private chat.

```ts
import { TelegramSimulator } from 'easytg/simulator';
import { mountChat } from 'easytg/simulator/element';

const sim = new TelegramSimulator();
// … connect your bot …
mountChat(document.querySelector('#chat')!, sim, { theme: 'auto' });
```

Or use the element: `<easytg-chat theme="dark" chat="-1001000000001">`,
then `element.simulator = sim`. Attributes: `chat` (default: the user's
private chat), `user` (who types; default the first user), `theme` (`light`,
`dark` or `auto`). Its height is `--easytg-chat-height` (540px).

## easytg in the browser

easytg has no Node-only dependencies, and bundlers pick its browser build
(the `browser` export condition, `dist/browser/`). One difference: browsers
have no `AsyncLocalStorage`, which easytg uses to recognise calls made from
inside a handler. `app.sendTo(bot, userId, …)` for the user whose update is
being handled still shares that update, but a queue job that enters the same
queue again waits for a free slot instead of running right away.

## Not simulated

Mini App pages themselves (their buttons open a dialog where you can send
`sendData`), file downloads, channels, forum topics, business connections,
poll votes, privacy mode and Telegram's rate limits (use
[`app.throttle()`](scaling.md) to pace messages anyway).
