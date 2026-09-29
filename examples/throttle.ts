/**
 * Staying within Telegram's rate limits: `app.throttle()` spaces outgoing
 * messages, `autoRetry()` waits out the "Too Many Requests" answers that
 * still happen.
 *
 *   BOT_TOKEN=123:abc bun run examples/throttle.ts
 *
 * Try it:
 * - /burst in a private chat: 10 messages go out at once (private chats have
 *   no limit by default).
 * - /burst in a group: the first 5 go out, the rest follow as the limit allows
 *   (this example uses 5 per 10 s for groups so you can watch it; Telegram's
 *   real limit is 20 per minute).
 * - /news: a broadcast to everyone who pressed /start, paced by the throttle.
 *
 * Telegram's limits, roughly: 30 messages per second for the whole bot, 20
 * per minute in one group, and about 1 per second in one private chat over
 * time (short bursts are fine). Going over them gets you 429 errors and, if
 * it keeps happening, slower delivery.
 */
import { Bot } from 'grammy';
import { EasyTG, autoRetry, page } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/throttle.ts');
  process.exit(1);
}

// Chats with rules of their own (put real chat ids here, e.g. from /start).
const ANNOUNCEMENTS_CHANNEL = Number(process.env.CHANNEL_ID ?? 0); // a channel that shouldn't flood its readers
const SUPPORT_GROUP = Number(process.env.SUPPORT_GROUP_ID ?? 0); // your own team group: no limit needed

const subscribers = new Set<number>();

const news = page('news').render(() => ({ text: '📰 Something new happened!', parseMode: 'plain' }));

const bot = new Bot(token);
const app = new EasyTG({
  // With several processes (see examples/production.ts), `cluster: true` and a
  // shared storage make every process count against the same limits.
}).register(news);

// Transformers run in reverse order of installation: the throttle (installed
// last) runs first and waits for a free slot, then autoRetry sends the call and
// retries it if Telegram still answers 429.
bot.api.config.use(autoRetry());
bot.api.config.use(
  app.throttle({
    // The whole bot: at most 25 messages per second (a little under Telegram's 30).
    global: { limit: 25, perMs: 1000 },
    // Every group, supergroup and channel: 5 per 10 s here, to see it working.
    // Leave it out for the default of 20 per minute.
    groupChat: { limit: 5, perMs: 10_000 },
    // Private chats: no limit by default, so a page split into several messages
    // arrives at once. To smooth long bursts: { limit: 1, perMs: 1000 }.
    // privateChat: { limit: 1, perMs: 1000 },

    // Rules for particular chats: return a rule, `false` (no limit) or
    // `undefined` (the defaults above).
    chat: (chatId) => {
      if (chatId === ANNOUNCEMENTS_CHANNEL) return { limit: 3, perMs: 60_000 };
      if (chatId === SUPPORT_GROUP) return false;
      return undefined;
    },

    // A call that waited this long goes out anyway (autoRetry then handles a 429).
    maxWaitMs: 60_000,
  }),
);

bot.use(app);

bot.command('start', async (ctx) => {
  subscribers.add(ctx.chat.id);
  await ctx.reply(`Subscribed. This chat's id is ${ctx.chat.id}. Try /burst and /news.`);
});

// Ten messages at once: in a private chat they arrive together, in a group
// they are spaced by the group rule. Nothing is lost and nothing gets a 429.
bot.command('burst', async (ctx) => {
  const started = Date.now();
  await Promise.all(Array.from({ length: 10 }, (_, i) => ctx.reply(`Message ${i + 1}`)));
  await ctx.reply(`All 10 sent in ${Math.round((Date.now() - started) / 1000)} s.`);
});

// Broadcasts pace themselves too (perSecond), and the throttle keeps them from
// eating the whole budget: replies to other users still get through.
bot.command('news', async (ctx) => {
  await ctx.reply(`Sending to ${subscribers.size} chat(s)…`);
  void app
    .broadcast(bot, subscribers, news, { perSecond: 20 })
    .then((result) => ctx.reply(`Done: ${result.sent} sent, ${result.blocked} blocked.`))
    .catch(console.error);
});

bot.catch((err) => console.error('Bot error:', err.error));
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start, then /burst.`) });
