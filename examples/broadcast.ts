/**
 * Newsletter bot: users subscribe, an admin writes a broadcast in a dialogue
 * and watches its progress. Also shows analytics events and anti-spam events.
 *
 *   BOT_TOKEN=123:abc ADMIN_ID=<your telegram user id> bun run examples/broadcast.ts
 *
 * Shows: app.broadcast (pacing, blocked users, progress), app.sendTo,
 * middlewares guarding a dialogue, events (pageView, dialogue*, spam).
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page, type Middleware } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc ADMIN_ID=<id> bun run examples/broadcast.ts');
  process.exit(1);
}
const ADMIN_ID = Number(process.env.ADMIN_ID ?? 0);

// A real bot keeps subscribers in a database; a Set keeps the example short.
const subscribers = new Set<number>();
const stats = { views: 0, broadcasts: 0 };

// ---- pages ------------------------------------------------------------------

const home = page('home').render(({ ctx, nav }) => {
  const subscribed = subscribers.has(ctx.chat!.id);
  return {
    text: ['**Newsletter**', subscribed ? '✅ You are subscribed.' : 'Get our news right here in Telegram.'],
    keyboard: [
      [subscribed ? nav.button('🔕 Unsubscribe', unsubscribe) : nav.button('🔔 Subscribe', subscribe)],
      ctx.from?.id === ADMIN_ID && [nav.button('📣 New broadcast', compose)],
    ],
  };
});

const subscribe = page('subscribe').render(({ ctx, session, nav }) => {
  subscribers.add(ctx.chat!.id);
  session.set('name', ctx.from?.first_name); // remembered for personal broadcasts
  return nav.redirect(home);
});

const unsubscribe = page('unsubscribe').render(({ ctx, nav }) => {
  subscribers.delete(ctx.chat!.id);
  return nav.redirect(home);
});

// What subscribers receive. It is rendered per recipient with *their* session,
// so it can be personal. (Broadcast renders have no incoming message: `ctx.from`
// only carries the user id, so keep what you need in the session.)
const news = page<{ text: string }>('news').render(({ params, session, nav }) => ({
  text: [md`📰 **News for ${session.get<string>('name') ?? 'you'}**`, '', params.text],
  keyboard: [[nav.button('🔕 Unsubscribe', unsubscribe)]],
}));

// ---- admin dialogue, guarded by a middleware -----------------------------------

// Middlewares also run before dialogues start, so a forged button can't open it.
const adminOnly: Middleware = ({ ctx }, next) => (ctx.from?.id === ADMIN_ID ? next() : { text: '⛔ Admins only.' });

const compose = dialogue<{ text: string; confirm: string }>('compose')
  .use(adminOnly)
  .steps(({ answers }) => [
    { id: 'text', type: 'text', text: 'What should we send?', validate: (t) => t.length <= 1000 || 'Max 1000 characters.' },
    {
      id: 'confirm',
      type: 'choice',
      text: [`Send this to ${subscribers.size} subscriber(s)?`, '', answers.text ?? ''],
      options: [
        { text: '🚀 Send', value: 'yes' },
        { text: '✏️ Rewrite', value: 'no' },
      ],
      // "Rewrite" is rejected with a message; the user presses Back to edit the text.
      validate: (value) => value === 'yes' || 'Press ⬅️ Back to rewrite it.',
    },
  ])
  .onFinish(async ({ answers, ctx }) => {
    const status = await ctx.reply(`Sending to ${subscribers.size}…`);
    const result = await app.broadcast(bot, subscribers, news, {
      params: { text: answers.text },
      perSecond: 20,
      // Live progress in one message (every 10 recipients, to stay within limits).
      onProgress: async ({ total, sent, blocked, failed }) => {
        if ((sent + blocked + failed) % 10 === 0) {
          await ctx.api.editMessageText(status.chat.id, status.message_id, `Sending… ${sent + blocked + failed}/${total}`).catch(() => {});
        }
      },
    });
    for (const chat of result.blockedChats) subscribers.delete(chat); // they blocked the bot
    stats.broadcasts++;
    return {
      text: [
        '**Broadcast done**',
        `✅ Sent: ${result.sent}`,
        `🚫 Blocked the bot: ${result.blocked} (removed)`,
        `⚠️ Failed: ${result.failed}`,
      ],
    };
  });

const statsPage = page('stats').use(adminOnly).render(() => ({
  text: ['**Stats**', `Subscribers: ${subscribers.size}`, `Page views: ${stats.views}`, `Broadcasts: ${stats.broadcasts}`],
}));

// ---- app & events --------------------------------------------------------------

const bot = new Bot(token);
const app = new EasyTG({ antiSpam: { limit: 15, windowMs: 10_000 } }).register(
  home,
  subscribe,
  unsubscribe,
  news,
  compose,
  statsPage,
);

app.on('pageView', () => void stats.views++);
app.on('dialogueFinish', ({ dialogue }) => console.log(`dialogue finished: ${dialogue}`));
app.on('spam', async ({ ctx, userId, strike, silence }) => {
  console.warn(`user ${userId} is flooding (strike ${strike})`);
  if (strike >= 3) {
    app.limitUser(userId, 60 * 60 * 1000); // mute for an hour
    silence(); // skip the default warning…
    await ctx.reply('You have been muted for an hour.').catch(() => {}); // …and send our own
  }
});

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.command('stats', (ctx) => app.open(ctx, statsPage));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({
  onStart: (me) => console.log(`@${me.username} is running.${ADMIN_ID ? '' : ' Set ADMIN_ID to try broadcasting.'}`),
});
