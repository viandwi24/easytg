/**
 * Persistent state in SQLite + sending pages without an incoming update.
 *
 *   BOT_TOKEN=123:abc bun run examples/notify.ts
 *
 * /start shows a counter that survives restarts (stored in easytg.sqlite).
 * "Remind me" sends a page to you 10 seconds later with `app.sendLater`: a
 * scheduled task saved in the database, so it is sent even if the bot
 * restarts in between. `app.sendTo` does the same right away, e.g. from a
 * cron job or a payment webhook.
 */
import { Database } from 'bun:sqlite';
import { Bot } from 'grammy';
import { EasyTG, SqliteStorage, isProactive, page } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/notify.ts');
  process.exit(1);
}

const bot = new Bot(token);
const storage = new SqliteStorage(new Database(process.env.DB_PATH ?? 'easytg.sqlite'));
const app = new EasyTG({
  storage,
  // Every button param is kept server-side: callback data can't be forged.
  buttons: { params: 'stored' },
});

const home = page<{ add?: string }>('home').render(({ params, session, nav }) => {
  let count = session.get<number>('count') ?? 0;
  if (params.add) {
    count += Number(params.add);
    session.set('count', count);
  }
  return {
    text: ['**Counter**', `Value: ${count}`, '', '_Restart the bot: the value is still there._'],
    keyboard: [
      [nav.self('+1', { add: 1 }), nav.self('+10', { add: 10 })],
      [nav.button('⏰ Remind me in 10s', remind)],
      [nav.close()],
    ],
  };
});

const remind = page('remind').render(async ({ ctx, nav }) => {
  const target = { chatId: ctx.chat!.id, userId: ctx.from!.id };
  await app.sendLater(target, reminder, { params: { at: new Date().toLocaleTimeString() }, delayMs: 10_000, botId: ctx.me.id });
  return { text: 'OK, I will ping you in 10 seconds. Try restarting the bot meanwhile.', keyboard: [[nav.home()]] };
});

const reminder = page<{ at: string }>('reminder').render(({ params, session, ctx, nav }) => ({
  text: [
    '⏰ **Reminder**',
    `Asked at ${params.at}, sent at ${new Date().toLocaleTimeString()} (${isProactive(ctx) ? 'no incoming update' : 'from a button'}).`,
    `Your counter is ${session.get<number>('count') ?? 0}.`,
  ],
  keyboard: [[nav.home('Open counter')]],
}));

app.register(home, remind, reminder);

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

setInterval(() => storage.purgeExpired(), 60 * 60 * 1000).unref();
const stopScheduler = app.startScheduler(bot); // sends due reminders
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
await stopScheduler();
