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

It is its own package, [`@easytg/simulator`](../packages/simulator/README.md),
which works with any grammY bot, with or without easytg. It's only needed for
tests and tools, so easytg doesn't install it: add it as a dev dependency
(`bun add -d @easytg/simulator`). easytg re-exports it, so in an easytg
project `easytg/simulator`,
`easytg/simulator/element` and `easytg/simulator/load` are the same modules as
`@easytg/simulator`, `@easytg/simulator/element` and `@easytg/simulator/load`.
This page uses the `easytg/…` names; without easytg:

```bash
bun add @easytg/simulator grammy    # or npm install
```

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

The first member creates a group and the bot is one of its admins
(`botAdmin: false` for a bot that isn't). Groups see every message (as with
privacy mode off). `type: 'group'` makes a basic group instead of a
supergroup.

### Channels

```ts
const news = sim.createChannel({ title: 'News', subscribers: [bob.id] }); // owner: the first user
await sim.send('New arrivals!', { chat: news.id });       // the owner posts: the bot gets channel_post
const carol = sim.addUser({ first_name: 'Carol' });
await sim.join(news.id, carol.id);                        // subscribers join quietly
```

The owner and admins post; subscribers only read (`sim.send` as one throws).
Posts carry `sender_chat` and no `from`, like Telegram's, and the bot needs to
be an admin to post (`botAdmin: false` shows the error). Edits arrive as
`edited_channel_post`.

### Topics (forums)

```ts
const forum = sim.createGroup({ title: 'Team', members: [alice.id, bob.id], forum: true });
const ideas = await sim.createTopic(forum.id, 'Ideas', { user: bob.id }); // the bot gets forum_topic_created
await sim.send('hi', { chat: forum.id, thread: ideas.id });               // in the topic
await sim.send('hi', { chat: forum.id });                                 // in "General"
```

A forum is a supergroup with `is_forum`. A topic's id is its
`message_thread_id`: the id of the message that created it; "General" is
thread 1 (`GENERAL_TOPIC`), whose messages carry no thread id. The bot's
replies stay in the topic of the message they reply to, and its topic methods
work: `createForumTopic`, `editForumTopic`, `closeForumTopic` (members can't
write there any more, admins can), `reopenForumTopic`, `deleteForumTopic`
(with its messages), and the `…GeneralForumTopic` ones.

## Ephemeral messages and drafts

Each user sees their own screen: `sim.messages(chatId, userId)` and
`sim.last(chatId, userId)` are what that user sees, with the
[ephemeral messages](groups.md#only-for-one-member-ephemeral) sent to them and
without those sent to others; a message an ephemeral one replaced is hidden
for its receiver until it is deleted. Without a user, every message is
listed. `press` and `tap` only find what the user sees, and the chat window
shows each user's own view ("👁 Only you can see this").

```ts
await sim.tap('⚙️ My settings', { chat: group.id, user: bob.id });
sim.last(group.id, bob.id)?.receiver;          // bob.id: only Bob sees it
sim.messages(group.id, alice.id);              // Alice still sees the menu
await sim.send('/mytasks', { chat: group.id, ephemeral: true }); // an ephemeral command
```

Ephemeral messages are checked like Telegram does: groups only, to a member,
and from a bot that isn't an admin only within 15 seconds of a press or in
reply to an ephemeral message (else `403 Forbidden`). A command listed with
`is_ephemeral` is sent ephemerally by `send`.

`sim.chat(userId).draft` is the [streamed draft](streaming.md) on screen
(`{ id, text, canStop }`, gone after 30 seconds or when the bot sends a
message), and `sim.stopGeneration(chatId?)` presses its ⏹ Stop. Disabled
buttons are greyed out; pressing one does nothing.

## What users can do

| | |
|---|---|
| `send(text, { user?, chat?, replyTo?, ephemeral? })` | a text message; `/commands`, links and mentions get their entities; `ephemeral`: for the bot only (groups) |
| `press(messageId, button, { user?, chat?, inlineMessageId? })` | an inline button; resolves with the answer: `{ text, alert, url }` |
| `pressReply(button, options?)` | a reply-keyboard button: text, `request_contact`, `request_location` |
| `sendMedia(kind, { url?, name?, caption? }, options?)` | a photo, document, video… |
| `sendContact(contact?, options?)` / `sendLocation(lat, lon, options?)` | contact (their own by default) and location |
| `sendWebAppData(data, buttonText, options?)` | what a Mini App sends with `Telegram.WebApp.sendData` |
| `editMessage(messageId, text, options?)` | edit one of their messages (an `edited_message` update) |
| `inlineQuery(query, { user?, chatType? })` | type `@bot query`; resolves with the bot's results |
| `chooseInlineResult(result, query, options?)` | send a result into a chat, "via @bot"; its buttons keep working |
| `pay(messageId, { shippingAddress?, shippingOption?, … })` | pay an invoice: shipping query (for `is_flexible` invoices), pre-checkout, then `successful_payment` |
| `join(chatId, userId)` / `leave(chatId, userId)` | join or leave a group |
| `requestToJoin(chatId, userId, { inviteLink?, bio?, query? })` | ask to join a supergroup or channel: the bot gets `chat_join_request` |
| `joinByLink(inviteLink, userId?)` | open an invite link the bot made: join, or ask to join when the link needs approval |
| `react(messageId, emoji \| emoji[], { user?, chat? })` | react to a message (`[]` takes the reaction back): the bot gets `message_reaction` |
| `block(userId?, blocked?)` | block the bot: sending to them fails with 403 |
| `stopGeneration(chatId?)` | press ⏹ Stop on a streamed draft |
| `tap(label, options?)` | the newest button with this label: inline, else on the reply keyboard |
| `update(raw)` | any other update |

## Rich messages

[Rich messages](rich-messages.md) are kept as Telegram returns them: Rich
Markdown, Rich HTML and blocks become `message.rich_message.blocks`, media in
them gets file ids, and the chat window draws them (tables, details, lists,
formulas as text, buttons). Buttons inside the text press like inline
buttons (`press`, `tap`). For tests:

```ts
import { messageText, richButtons } from 'easytg/simulator';

messageText(sim.last()!.message);                    // text, caption, or a rich message as plain text
richButtons(sim.last()!.message.rich_message);       // its buttons, in order
sim.fileUrl(fileId);                                 // where a file the bot sent can be seen
```

Unsupported HTML tags, media that isn't an http(s) URL or a `tg://…?id=`
reference to `media`, and content in more than one of `markdown` / `html` /
`blocks` are refused with a 400. The parser follows Telegram's description,
not its code: test unusual constructs on Telegram. Plain URLs, mentions and
commands in rich text aren't detected.

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
- `setMyName`, `setMyDescription`, `setMyShortDescription` and
  `setMyDefaultAdministratorRights` are kept (per `language_code`, falling
  back to the one for all languages) and their `getMy…` methods return them.
- The simulator knows no sticker sets until you add one:
  `sim.addStickerSet({ name, title?, type?, emojis? })` makes a set with one
  sticker per emoji (their file ids work with `sendSticker`), for
  `getStickerSet`, `getCustomEmojiStickers` and `setChatStickerSet`; other
  names fail with `STICKERSET_INVALID`.

## Groups: settings, invite links and join requests

With the bot an admin (and the right for it, e.g. `can_change_info`;
otherwise `Bad Request: not enough rights to …`):

- `setChatTitle` posts a `new_chat_title` service message, `setChatPhoto` (an
  uploaded file, not a file id) `new_chat_photo` and `deleteChatPhoto`
  `delete_chat_photo`; `getChat` returns the title, `description`, `photo`,
  `permissions`, primary `invite_link`, `pinned_message` and
  `sticker_set_name`.
- `setChatPermissions` sets what members may do, with Telegram's implications
  (unless `use_independent_chat_permissions`); without `can_send_messages`
  members can't write (`sim.send` throws), admins still can.
- `setChatAdministratorCustomTitle` and `setChatMemberTag` show in
  `getChatMember` (`custom_title`, `tag`); `banChatSenderChat` keeps
  `chat.bannedSenderChats`.
- Invite links: `exportChatInviteLink` (a new primary link, the old one
  revoked), `createChatInviteLink`, `editChatInviteLink`,
  `revokeChatInviteLink` and the subscription ones for channels. Users join
  through them with `sim.joinByLink(link, userId)`; revoked, expired and full
  links throw.
- Join requests: `sim.requestToJoin(chatId, userId)` (or a link with
  `creates_join_request`) sends `chat_join_request`, which the bot answers with
  `approveChatJoinRequest` (the user joins; groups show "joined") or
  `declineChatJoinRequest`. While it is pending the bot may write to the user
  (`user_chat_id`). With `{ query: true }` the request has a `query_id` for
  `answerChatJoinRequestQuery` or `sendChatJoinRequestWebApp` (an `open`
  event for the user).

```ts
const link = await bot.api.createChatInviteLink(group.id, { creates_join_request: true });
bot.on('chat_join_request', (ctx) => ctx.approveChatJoinRequest(ctx.from.id));
await sim.joinByLink(link.invite_link, carol.id);   // resolves once Carol has joined
```

Updates caused by the bot's own calls (Carol joining after an approval, a
`refunded_payment` after `refundStarPayment`) reach the bot after the update
it is handling, before the user's action resolves.

## Payments, polls and locations

- An invoice sent with `is_flexible` asks the bot for shipping options
  (`shipping_query`, answered with `answerShippingQuery`) when a user pays;
  the chosen option is added to the total and to `successful_payment`. The
  `need_*` flags fill `order_info`. Stars invoices have no shipping, like on
  Telegram.
- `refundStarPayment` refunds a Stars payment once (`CHARGE_ALREADY_REFUNDED`
  the second time) and posts `refunded_payment` in the user's chat.
  `createInvoiceLink` returns a `https://t.me/$…` link (users can't open it in
  the simulator).
- `stopPoll` closes a poll (`is_closed`) and returns it.
- `sendLocation` with `live_period` sends a live location
  (`SimMessage.liveUntil`); `editMessageLiveLocation` moves it and
  `stopMessageLiveLocation` stops it. Afterwards, or once it expired, both
  fail with `message can't be edited`. `sendVenue` sends a venue.

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
loading indicators; `[120, 280]` picks a delay in that range each time, like
a real network (the playground and the studio use that). `sim.latencyMs` can
be changed while running. `rateLimits: true` answers floods with Telegram's
`429 Too Many Requests: retry after N` (30 messages per second overall, 20
per minute per group, counted in fixed windows like `app.throttle`); pass
`{ global, groupChat, privateChat }` rules (`{ limit, perMs }` or `false`) for
your own. Sending, copying, forwarding and editing count, an album one per
item. `sim.clearHistory(chatId?)` empties one chat like
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
`dark` or `auto`), `sidebar` (`auto` or `hide`). Its height is
`--easytg-chat-height` (540px).

From 680px wide, the window looks like Telegram on a computer: on the left
your chats, latest first (your chat with the bot, your groups and channels,
each with its last message), and at the bottom the profile you are typing
as. Click it to switch to another user, or **New profile** to add one (first
and last name, username, language: `language_code` for bots with
[several languages](i18n.md)). Every profile sees only its own chats, so you
can try a bot as several people.

**✎** above the chats makes a group, a supergroup, a group with topics or a
channel, with the profiles you pick as members (you create it; the bot is an
admin unless you untick it). A group with topics gets a second column with
its topics, like Telegram on a computer: "General" is open first, **＋** adds a
topic. In a narrow window it opens on its topic list instead (‹ goes back to
it), with **＋ New topic** at the bottom. In a channel you post
as its owner and read as a subscriber.

Pressed buttons show a spinner until the bot has answered, as on Telegram;
with `latencyMs` you see it. A message and its buttons are as wide as the
wider of the two, the buttons of a row equally wide. Photos and videos take
their place at once and show a spinner until the file has loaded; an edited
photo keeps its size while the new one loads.

In a narrower window the chat and the user are picked at the top of the
chat, and **New profile** and **New group or channel** are in the ⋮ menu.
`sidebar="hide"` keeps the narrow layout at any width.

## easytg in the browser

easytg has no Node-only dependencies, and bundlers pick its browser build
(the `browser` export condition, `dist/browser/`). One difference: browsers
have no `AsyncLocalStorage`, which easytg uses to recognise calls made from
inside a handler. `app.sendTo(bot, userId, …)` for the user whose update is
being handled still shares that update, but a queue job that enters the same
queue again waits for a free slot instead of running right away.

## Not simulated

Mini App pages themselves (their buttons open a dialog where you can send
`sendData`), file downloads, channel comments, business connections, poll
votes, chat boosts (`getUserChatBoosts` returns none), paying invoice links
and privacy mode. Which Bot API methods are answered, and which aren't, is
listed in [Bot API coverage](bot-api-coverage.md). Telegram's rate limits only with `rateLimits`
(see [Watching](#watching)).
