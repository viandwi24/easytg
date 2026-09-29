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

## Admin-only pages and dialogues

```ts
import { requireChatAdmin } from 'easytg';

page('settings').use(requireChatAdmin()).render(...);
dialogue('ban').use(requireChatAdmin({ right: 'can_restrict_members' })).steps(...);
```

In groups only the chat's admins (and its owner) get through; others get the
`adminOnly` toast when they press a button. Private chats always pass. The
admin status is asked from Telegram and remembered for `cacheMs` (default 5
minutes).

## State for the whole chat

Each user has their own `session` per chat. State of the chat itself lives in
the [chat session](sessions.md#chat-sessions):

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

[`examples/group.ts`](../examples/group.ts) is a group bot with admin-only
settings, a live scoreboard and a quiz.
