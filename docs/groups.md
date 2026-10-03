# Groups

easytg works in groups as in private chats, with a few differences.

## Who may press a menu

A menu opened in a group belongs to the user it was opened for: others get
"This menu belongs to someone else" (`buttons.ownerOnly`, default on). To
share one menu with several people, send it with `allowedUsers`; they keep
that right on every page the menu shows afterwards:

```ts
await app.sendTo(bot, { chatId: groupId, allowedUsers: adminIds }, reviewCard, { id });
```

`buttons: { ownerOnly: false }` lets anyone press any menu (check rights in
middlewares then).

## Only for one member (ephemeral)

Telegram (Bot API 10.2) can show a message in a group to one member only: an
ephemeral message, marked "Only you can see this". Open a page or start a
dialogue from a shared menu with `mode: 'ephemeral'`:

```ts
const board = page('board').render(({ nav }) => ({
  text: '📋 Team board',
  keyboard: [
    [nav.button('⚙️ My settings', settings, {}, { mode: 'ephemeral' })], // for the presser only
    [nav.button('📊 Results', results)],                                 // for everyone
  ],
}));
```

- The page takes the menu's place **on the presser's screen**; the others
  keep seeing the menu, and can open their own copy at the same time. Use
  `buttons: { ownerOnly: false }` (or `allowedUsers`) so others may press the
  shared menu.
- The buttons of an ephemeral page edit that copy (`editEphemeralMessage…`),
  Back goes back through it to the menu, and Close removes it, which shows
  the menu again.
- A dialogue started this way asks the presser only; its questions are
  removed like any dialogue's, and the menu stays for everyone.
- Something sent from an ephemeral page (a button with `mode: 'send'`, a
  long text's next part) is ephemeral too. Albums, copies and invoices can't
  be ephemeral: they throw.
- In private chats `ephemeral` is just `edit`.
- An admin bot may send ephemeral messages at any time. A bot that isn't an
  admin only within 15 seconds of the press (easytg answers right away, so
  this matters only for slow pages), or in reply to an
  [ephemeral command](commands.md#ephemeral-commands).

`app.open(ctx, page, params, { mode: 'ephemeral' })` does the same from a
button press of your own.

## Admin-only pages and dialogues

```ts
import { requireChatAdmin } from 'easytg';

page('settings').use(requireChatAdmin()).render(...);
dialogue('ban').use(requireChatAdmin({ right: 'can_restrict_members' })).steps(...);
```

In groups only the chat's admins (and its owner) get through; others get the
`adminOnly` toast when they press a button (and nothing at all otherwise, e.g.
for a page opened by a command). Private chats and channels always pass. The
admin status is asked from Telegram and remembered for `cacheMs` (default 5
minutes).

## State for the whole chat

Each user has their own `session` per chat, and a user session that follows
them into every group. State of the chat itself lives in the
[chat session](sessions.md#per-chat-and-per-user):

```ts
const chat = await app.chatSession(ctx);
const settings = chat.get<Settings>('settings') ?? defaults;
```

## Text in groups

With privacy mode on (the default for bots), a bot in a group only receives
commands and replies to its own messages. Dialogue answers and
[page text input](text-input.md) then need to be replies to the bot's
message; turn privacy mode off in @BotFather (`/setprivacy`) to receive every
message. Page text input only accepts replies to the page's message in groups
anyway.

In forum groups, pages stay in the topic they were opened in; `sendTo` takes a
`threadId` for a topic.

[`examples/group.ts`](../examples/group.ts) is a group bot with admin-only
settings, a live scoreboard and a quiz.
[`examples/team.ts`](../examples/team.ts) is a team board with ephemeral
settings, an ephemeral vote, ephemeral commands and a disabled button.
