/**
 * Reminders that survive restarts: scheduled tasks saved in SQLite.
 *
 *   BOT_TOKEN=123:abc bun run examples/reminders.ts
 *
 * Shows: `task(...)` with a typed payload, `app.schedule` (once and with
 * `every`), `app.cancelTask`, `app.deleteLater`, `deleteAfterMs`, and
 * `app.startScheduler`. Stop the bot while a reminder is pending and start it
 * again: the reminder still arrives (late ones right after the start).
 */
import { Database } from 'bun:sqlite';
import { Bot } from 'grammy';
import { EasyTG, SqliteStorage, dialogue, md, page, task } from '../src';

interface Reminder {
  id: string;
  text: string;
  at: number;
}

// ---- tasks ----------------------------------------------------------------------

/** Runs when a reminder is due, in whichever process polls first. */
const remind = task<{ chatId: number; userId: number; text: string; id: string }>('remind').run(async ({ payload, app, bot }) => {
  await app.sendTo(bot, { chatId: payload.chatId, userId: payload.userId }, reminderCard, { id: payload.id, text: payload.text });
});

/** A recurring task: scheduled once with `every`, it runs again and again. */
const dailyTip = task<{ chatId: number }>('daily-tip').run(async ({ payload, bot }) => {
  await bot.api.sendMessage(payload.chatId, '💡 Tip of the day: drink some water.');
});

// ---- pages ------------------------------------------------------------------------

const home = page('home').render(({ session, nav }) => {
  const reminders = session.get<Reminder[]>('reminders') ?? [];
  return {
    text: ['**Reminders**', reminders.length ? `You have ${reminders.length} pending.` : 'Nothing planned.'],
    keyboard: [
      [nav.button('➕ New reminder', newReminder)],
      reminders.length > 0 && [nav.button('📋 My reminders', list)],
      [nav.button(session.get('tipId') ? '🔕 Stop daily tips' : '💡 Daily tips', tips)],
    ],
  };
});

const newReminder = dialogue<{ text: string; delay: string }>('new-reminder')
  .steps([
    { id: 'text', type: 'text', text: 'What should I remind you of?', validate: (t) => t.length <= 200 || 'Keep it under 200 characters.' },
    {
      id: 'delay',
      type: 'choice',
      text: 'When?',
      columns: 3,
      options: [
        { text: '1 minute', value: '60' },
        { text: '10 minutes', value: '600' },
        { text: '1 hour', value: '3600' },
      ],
    },
  ])
  .onFinish(async ({ ctx, answers, session, nav }) => {
    const at = Date.now() + Number(answers.delay) * 1000;
    const id = `remind:${ctx.from!.id}:${at}`; // our own id, to cancel it later
    await app.schedule(remind, { chatId: ctx.chat!.id, userId: ctx.from!.id, text: answers.text, id }, { at, id });
    session.set('reminders', [...(session.get<Reminder[]>('reminders') ?? []), { id, text: answers.text, at }]);
    return {
      text: md`⏰ I'll remind you of **${answers.text}** at ${new Date(at).toLocaleTimeString()}.`,
      keyboard: [[nav.home()]],
      deleteAfterMs: 60_000, // this confirmation cleans itself up after a minute
    };
  });

const list = page<{ cancel?: string }>('list').render(async ({ params, session, nav }) => {
  let reminders = session.get<Reminder[]>('reminders') ?? [];
  if (params.cancel) {
    await app.cancelTask(params.cancel);
    reminders = reminders.filter((r) => r.id !== params.cancel);
    session.set('reminders', reminders);
  }
  if (!reminders.length) return nav.redirect(home);
  return {
    text: ['**Pending reminders**', ...reminders.map((r) => md`- ${new Date(r.at).toLocaleTimeString()}: ${r.text}`)],
    keyboard: [...reminders.map((r) => [nav.self(`❌ ${r.text.slice(0, 20)}`, { cancel: r.id })]), [nav.home()]],
  };
});

const reminderCard = page<{ id: string; text: string }>('reminder').render(({ params, session, nav }) => {
  session.set('reminders', (session.get<Reminder[]>('reminders') ?? []).filter((r) => r.id !== params.id));
  return { text: md`⏰ **Reminder:** ${params.text}`, keyboard: [[nav.home('Open reminders')]] };
});

const tips = page('tips').render(async ({ ctx, session, nav }) => {
  const tipId = session.get<string>('tipId');
  if (tipId) {
    await app.cancelTask(tipId);
    session.delete('tipId');
    return { text: 'Daily tips stopped.', keyboard: [[nav.home()]] };
  }
  const id = `tip:${ctx.chat!.id}`; // one per chat: scheduling again replaces it
  await app.schedule(dailyTip, { chatId: ctx.chat!.id }, { delayMs: 10_000, everyMs: 24 * 60 * 60 * 1000, id });
  session.set('tipId', id);
  return { text: 'You will get a tip every day (the first one in 10 seconds).', keyboard: [[nav.home()]] };
});

// ---- app ------------------------------------------------------------------------

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/reminders.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  storage: new SqliteStorage(new Database(process.env.DB_PATH ?? 'reminders.sqlite')), // sessions and tasks
  scheduler: { pollMs: 1000, maxAttempts: 3 },
}).register(home, newReminder, list, reminderCard, tips, remind, dailyTip);

app.on('taskError', ({ task, error, willRetry }) => console.error(`task ${task.name} failed (retry: ${willRetry})`, error));

bot.use(app);
bot.command('start', async (ctx) => {
  await app.open(ctx, home);
  await app.deleteLater(ctx, ctx.msg.message_id, { delayMs: 5_000 }); // tidy up the /start message
});
bot.catch((err) => console.error('Bot error:', err.error));

const stopScheduler = app.startScheduler(bot);
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
await stopScheduler(); // let running tasks finish
