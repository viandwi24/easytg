/**
 * A bot with a Mini App: a small web page inside Telegram, served by this
 * same process, that talks to the bot.
 *
 *   BOT_TOKEN=123:abc WEBAPP_URL=https://<your-tunnel> PORT=8080 bun run examples/mini-app.ts
 *
 * Mini Apps must be served over https. For local testing, expose PORT with a
 * tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`) and pass its
 * https address as WEBAPP_URL.
 *
 * Three ways the Mini App and the bot talk here:
 * 1. Reply-keyboard button (replyMenu.webApp / a `webApp` dialogue step): the
 *    Mini App calls `Telegram.WebApp.sendData(...)`, closes, and the data
 *    arrives in the bot (the `webAppData` event, or as the step's answer).
 * 2. Inline button (nav.webApp): the Mini App calls your server with its
 *    `initData`; the server checks it with `verifyInitData`, updates the
 *    user with `app.withUser`, and answers with `app.answerWebAppQuery`,
 *    which posts a page into the chat.
 * 3. Sharing: `app.prepareShare` prepares a page the user can send to any
 *    chat from the Mini App (`Telegram.WebApp.shareMessage(id)`).
 */
import { Bot } from 'grammy';
import { EasyTG, WebAppAuthError, dialogue, md, page, replyMenu, verifyInitData, type StandardSchemaV1 } from '../src';

const env = process.env;
if (!env.BOT_TOKEN || !env.WEBAPP_URL) {
  console.error('Missing BOT_TOKEN or WEBAPP_URL. See the top of examples/mini-app.ts.');
  process.exit(1);
}
const TOKEN = env.BOT_TOKEN;
const WEBAPP_URL = env.WEBAPP_URL.replace(/\/$/, '');
const PORT = Number(env.PORT ?? 8080);

// ---- pages and a dialogue ---------------------------------------------------------

const home = page('home').render(async ({ ctx, app, nav }) => {
  const plan = (await app.userSession(ctx)).get<string>('plan') ?? 'free';
  return {
    text: [md`**Hello ${ctx.from?.first_name ?? ''}!**`, `Your plan: ${plan}`],
    // An inline button: the Mini App gets a query id and answers through our server.
    keyboard: [[nav.webApp('🛒 Open the shop', `${WEBAPP_URL}/`)], [nav.button('🎨 Pick a color', pickColor)]],
  };
});

// What users share from the Mini App into any chat (prepareShare). Shared messages
// land in chats with other people and bots, so only plain link buttons here:
// Mini App (web_app) buttons work in private chats only, dialogues need a chat.
const invite = page('invite').render(({ ctx, nav }) => ({
  text: '🛒 Come and see this shop!',
  keyboard: [[nav.url('Open the bot', `https://t.me/${ctx.me.username}`)]],
}));

// What the server posts into the chat after a purchase (answerWebAppQuery).
const receipt = page<{ item: string }>('receipt').render(({ params }) => ({
  text: md`✅ Bought **${params.item}**. Enjoy!`,
}));

// Data from a Mini App comes from the client: check it (here with a tiny
// Standard Schema; zod or valibot work the same).
const color: StandardSchemaV1<unknown, { color: string }> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: (value) => {
      const c = (value as { color?: unknown } | null)?.color;
      return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? { value: { color: c } } : { issues: [{ message: 'Please pick a color.' }] };
    },
  },
};

// A dialogue step that opens a Mini App from the keyboard; its data is the answer.
const pickColor = dialogue('pick-color')
  .steps([{ id: 'color', type: 'webApp', text: 'Open the picker below 👇', url: `${WEBAPP_URL}/?picker=1`, button: '🎨 Open picker', schema: color }])
  .onFinish(async ({ ctx, answers, app, nav }) => {
    // answers.color is typed { color: string } from the schema.
    (await app.userSession(ctx)).set('color', answers.color.color);
    return { text: `Your color is ${answers.color.color}.`, keyboard: [[nav.home()]] };
  });

// ---- the bot -------------------------------------------------------------------------

const bot = new Bot(TOKEN);
const app = new EasyTG({
  // A reply-keyboard button that opens the Mini App; sendData arrives as `webAppData`.
  menu: replyMenu([[replyMenu.webApp('⭐ Feedback', `${WEBAPP_URL}/?feedback=1`), replyMenu.close()]]),
}).register(home, invite, receipt, pickColor);

app.on('webAppData', async ({ ctx, data }) => {
  const rating = Number((data as { rating?: unknown })?.rating);
  if (rating >= 1 && rating <= 5) await ctx.reply(`Thanks for the ${'⭐'.repeat(rating)}!`);
});

bot.use(app);
bot.command('start', async (ctx) => {
  await app.showMenu(ctx, 'Welcome! The ⭐ button below opens a Mini App too.');
  await app.open(ctx, home);
});
bot.catch((err) => console.error('Bot error:', err.error));

// ---- the Mini App itself: a plain page with Telegram's script (defined before the server uses it) ---

const MINI_APP_HTML = `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; background: var(--tg-theme-bg-color); color: var(--tg-theme-text-color); }
    button { display: block; width: 100%; margin: 8px 0; padding: 12px; border: 0; border-radius: 8px;
             background: var(--tg-theme-button-color); color: var(--tg-theme-button-text-color); font-size: 16px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h2 id="hello">Hello!</h2>
  <div id="shop">
    <button onclick="buy('Pro plan')">Buy Pro plan</button>
    <button onclick="share()">Share the shop</button>
  </div>
  <div id="picker" class="hidden">
    <input id="color" type="color" value="#3390ec" style="width:100%;height:120px;border:0">
    <button onclick="Telegram.WebApp.sendData(JSON.stringify({ color: document.getElementById('color').value }))">Use this color</button>
  </div>
  <div id="feedback" class="hidden">
    ${[1, 2, 3, 4, 5].map((n) => `<button onclick="Telegram.WebApp.sendData(JSON.stringify({ rating: ${n} }))">${'⭐'.repeat(n)}</button>`).join('')}
  </div>
  <script>
    const app = Telegram.WebApp;
    app.ready();
    document.getElementById('hello').textContent = 'Hello ' + (app.initDataUnsafe.user?.first_name ?? '') + '!';
    const query = new URLSearchParams(location.search);
    if (query.has('picker') || query.has('feedback')) {
      document.getElementById('shop').classList.add('hidden');
      document.getElementById(query.has('picker') ? 'picker' : 'feedback').classList.remove('hidden');
    }
    // Every request carries initData, which the server checks.
    const call = (path, body) =>
      fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: app.initData, ...body }) }).then((r) => r.json());
    async function buy(item) {
      await call('/api/buy', { item });
      app.close();
    }
    async function share() {
      const { id } = await call('/api/share', {});
      app.shareMessage(id);
    }
  </script>
</body>
</html>`;

// ---- the Mini App's server --------------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status });

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(MINI_APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = (await request.json().catch(() => ({}))) as { initData?: string; item?: string };
      let init;
      try {
        // Never trust the user id a Mini App claims: check initData with the bot token.
        init = verifyInitData(body.initData ?? '', TOKEN, { maxAgeMs: 60 * 60 * 1000 });
      } catch (error) {
        if (error instanceof WebAppAuthError) return json({ error: error.reason }, 401);
        throw error;
      }
      const user = init.user!;

      if (url.pathname === '/api/buy') {
        const item = String(body.item ?? 'Pro plan').slice(0, 50);
        // Update the user like an update would: their sessions, saved at the end.
        await app.withUser(bot, user.id, ({ userSession }) => userSession.set('plan', 'pro'));
        // Opened from an inline button: post the receipt into the chat and close the Mini App.
        if (init.queryId) await app.answerWebAppQuery(bot, init.queryId, receipt, { userId: user.id, params: { item }, title: 'Receipt' });
        else await app.sendTo(bot, user.id, receipt, { item });
        return json({ ok: true });
      }

      if (url.pathname === '/api/share') {
        // A message the user can send to any chat: WebApp.shareMessage(id).
        const prepared = await app.prepareShare(bot, user.id, invite, { title: 'My shop' });
        return json({ id: prepared.id });
      }
    }
    return new Response('Not found', { status: 404 });
  },
});

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running; Mini App at ${WEBAPP_URL} (port ${PORT}).`) });
