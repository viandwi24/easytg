# Mini Apps

A Mini App is a web page that opens inside Telegram. You build its UI; easytg
connects it to your bot: buttons that open it, checking who is calling your
server, and ways to get results back into the chat.

## Opening a Mini App

| from | how | what comes back |
|---|---|---|
| an inline button | `nav.webApp('Open', url)` | the Mini App calls your server; `initData.queryId` lets you answer with a message ([below](#answering-with-a-message)) |
| a reply-keyboard button | `replyMenu.webApp('Open', url)` | `Telegram.WebApp.sendData(...)` arrives as the `webAppData` event |
| a dialogue step | `{ type: 'webApp', url, … }` | `sendData(...)` becomes the step's answer |
| a link | `miniAppLink(botUsername, { app, startParam, mode })` | `initData.startParam` |
| the menu button | `bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text, web_app: { url } } })` | like an inline button |

Mini Apps need an `https://` URL. Reply-keyboard Mini Apps, and `sendData`,
only work in private chats.

## Checking who is calling

The Mini App has `Telegram.WebApp.initData`: send it with every request to
your server, and check it there. Never trust a user id a Mini App sends
without it.

```ts
import { verifyInitData, WebAppAuthError } from 'easytg';

try {
  const init = verifyInitData(body.initData, process.env.BOT_TOKEN!, { maxAgeMs: 3600_000 });
  init.user;        // { id, first_name, language_code, … }
  init.queryId;     // opened from an inline button or the menu button
  init.startParam;  // from ?startapp=…
} catch (error) {
  if (error instanceof WebAppAuthError) return new Response(error.reason, { status: 401 }); // 'invalid' | 'expired' | 'malformed'
  throw error;
}
```

- `maxAgeMs` (default 24 hours) rejects old `initData`; `Infinity` accepts any age.
- A server that shouldn't hold the bot token can use
  `verifyInitDataSignature(initData, botId)`, which checks Telegram's Ed25519
  signature with Telegram's public key instead (`{ environment: 'test' }` for
  the test server).

## Acting for the user

`app.withUser` gives your server what a handler has: the user's session in
their private chat with the bot, their user session, `t` in their language
and `nav`. Changes are saved at the end, in step with the user's own updates:

```ts
await app.withUser(bot, init.user!.id, async ({ session, userSession, t }) => {
  userSession.set('plan', 'pro');
});
await app.sendTo(bot, init.user!.id, receipt, { item: 'Pro plan' });
```

`withUser` is just as useful for webhooks from a payment provider or an
admin panel.

## Answering with a message

A Mini App opened from an inline button or the menu button can put a page
into the chat (as a message from the user) and close:

```ts
if (init.queryId) {
  await app.answerWebAppQuery(bot, init.queryId, receipt, { userId: init.user!.id, params: { item }, title: 'Receipt' });
}
```

The page is rendered like an [inline result](inline-mode.md): text or photo
pages, with buttons that keep working in the sent message.

## Sharing

`app.prepareShare` prepares a page the user can send to any chat they pick;
the Mini App then calls `Telegram.WebApp.shareMessage(id)`:

```ts
const { id, expirationDate } = await app.prepareShare(bot, init.user!.id, invite, { title: 'Join me', allowChannelChats: false });
return Response.json({ id });
```

By default it may be sent to users, groups and channels (`allowUserChats`,
`allowGroupChats`, `allowChannelChats`: true) but not to bots
(`allowBotChats`: false). The shared message lands in other people's chats:
give it plain link buttons (`nav.url`, `miniAppLink`), since Mini App
buttons work in private chats only and dialogues need a chat.

## Data sent with `sendData`

From a reply-keyboard button (`replyMenu.webApp`) the Mini App can send up
to 4096 bytes with `Telegram.WebApp.sendData(...)` and close. easytg parses
JSON:

```ts
app.on('webAppData', async ({ ctx, data, raw, button }) => {
  // data: parsed JSON (or the string), raw: as sent, button: the button's label
});
```

In a dialogue, a `webApp` step waits for that data, e.g. from a date picker or
a map; a [Standard Schema](dialogues.md) checks and types it:

```ts
dialogue('booking').steps([
  { id: 'when', type: 'webApp', text: 'Pick a date', url: `${BASE}/calendar`, button: '📅 Open calendar', schema: z.object({ date: z.string() }) },
]).onFinish(({ answers }) => ({ text: `Booked for ${answers.when.date}` }));
```

The data comes from the client: always check it.

[`examples/mini-app.ts`](../examples/mini-app.ts) is a bot and its Mini App
in one file: an inline shop button with a server that checks `initData`, a
color picker step, feedback from a keyboard button, and sharing.
