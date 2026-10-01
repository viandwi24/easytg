# Relays: users talking through the bot

A relay connects two users: what one sends the bot in their private chat is
copied to the other, so neither sees the other's account. Anonymous chats,
support desks, a buyer and a seller, a match in a dating bot.

```ts
await app.relay.start(ctx, ctx.from!.id, sellerId);           // both are connected now
await app.relay.peer(ctx, ctx.from!.id);                       // { peer, since, data } or undefined
await app.relay.end(ctx, ctx.from!.id);                        // ends it for both; returns the link
```

- Messages are copied with `copyMessage`: text, photos, voice notes, files,
  locations… arrive from the bot.
- A reply to a relayed message is a reply to its counterpart on the other
  side, and editing a message edits its copy (text and captions). Message
  pairs are kept for 7 days in the session storage.
- Service messages (Mini App data, payments, pins) aren't relayed: they go
  on to their handlers. Telegram doesn't tell bots when someone is typing,
  so "typing…" can't be passed on.
- /commands, [menu](menu.md) buttons, active [dialogues](dialogues.md) and
  buttons keep working as usual and aren't relayed, so a `/end` command (and
  anything else) stays available.
- Private chats only. The other user must have started the bot, like for
  any message the bot sends.
- `start` ends the users' earlier relays (a `relayEnd` event each).
  Options: `ttlMs` ends the relay by itself (silently: schedule a
  [task](scheduler.md) to announce it), `data` is anything JSON you want
  back from `peer`.
- The first argument is `ctx` or the bot (`bot`, after `bot.init()`).
- Relays live in the session storage, so they survive restarts and work
  across processes with a shared storage.

## Checking messages

```ts
new EasyTG({
  relay: {
    // false drops the message; a string drops it and tells the sender why.
    filter: ({ ctx }) => (/https?:\/\//.test(ctx.message?.text ?? '') ? 'Links are not allowed here.' : true),
  },
});
```

## Events

```ts
app.on('relayMessage', ({ from, to }) => stats.count(from, to));
app.on('relayEnd', async ({ users, reason, ctx }) => {
  // reason 'unreachable': the other user blocked the bot. `ctx` is the sender's update: tell them.
  if (reason === 'unreachable') await ctx?.reply('They left the chat.');
});
```

`relayEnd` fires for `app.relay.end` and for relays that `start` replaced
(`reason: 'app'`), and when a message can't be delivered because the other
user blocked the bot (`reason: 'unreachable'`, with the sender's `ctx`).

## Try it

Switch between the two users at the top of the chat to play both sides.

```ts playground users
import { Bot } from 'grammy';
import { EasyTG, page } from 'easytg';

// Stands in for your database: who is waiting for a partner.
let waiting: number | undefined;

const home = page('home').render(() => ({ text: 'Anonymous chat: /find a partner, /end to leave.' }));
const connected = page('connected').render(() => ({ text: '💬 Connected! Your messages now go to your partner. /end to leave.' }));
const left = page('left').render(() => ({ text: 'Your partner left. /find someone new.' }));

const find = page('find').render(async ({ ctx, app, nav }) => {
  const me = ctx.from!.id;
  if (await app.relay.peer(ctx, me)) return { text: 'You are already chatting. /end first.' };
  if (waiting === undefined || waiting === me) {
    waiting = me;
    return { text: '🔎 Waiting for someone… Switch to the other user at the top and send /find.' };
  }
  const partner = waiting;
  waiting = undefined;
  await app.relay.start(ctx, me, partner);
  await app.sendTo(bot, partner, connected);
  return nav.redirect(connected);
});

const end = page('end').render(async ({ ctx, app }) => {
  const link = await app.relay.end(ctx, ctx.from!.id);
  if (!link) return { text: "You aren't chatting." };
  await app.sendTo(bot, link.peer, left);
  return { text: 'You left the chat.' };
});

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG()
  .command('start', home)
  .command('find', find, { description: 'Find a partner' })
  .command('end', end, { description: 'Leave the chat' })
  .register(connected, left);
bot.use(app);
await app.syncCommands(bot);
bot.start();
```

[`examples/support.ts`](../examples/support.ts) is a support desk: customers
open tickets, an agent takes one and they talk through a relay, with a link
filter and a rating at the end. [`examples/match.ts`](../examples/match.ts)
uses a relay for matches who want to chat, and hides both users' reply
keyboards while they do (`app.hideMenu`, and `app.withUser` for the other
side).
