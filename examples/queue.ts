/**
 * Slow jobs (an AI model, video rendering, an export…) behind a queue: at
 * most 2 run at once, each user may have one job at a time, and waiting users
 * see their place in line.
 *
 *   BOT_TOKEN=123:abc bun run examples/queue.ts
 *
 * Send /ask <question> or press "Generate a poem" from several accounts (or
 * quickly one after another) to see the queue at work.
 *
 * Note: grammY's `bot.start()` handles one update at a time for the whole bot,
 * so one slow job would stall everyone. Run updates concurrently, e.g. with
 * webhooks or @grammyjs/runner (used here when installed); easytg keeps each
 * user's own updates in order (`sequential`).
 */
import { Bot, type Context } from 'grammy';
import { EasyTG, QueueFullError, QueueTimeoutError, page } from '../src';

/** Stands in for a call to an AI model. */
async function slowModel(prompt: string) {
  await Bun.sleep(4000 + Math.random() * 3000);
  return `🤖 Here is my answer to "${prompt}": 42.`;
}

const home = page('home').render(({ nav }) => ({
  text: ['**Ask the robot**', 'Send `/ask <question>`, or:'],
  keyboard: [[nav.button('✍️ Generate a poem', poem)]],
}));

// A render may take as long as it needs; other buttons of this user get a
// "please wait" toast meanwhile.
const poem = page('poem').render(async ({ ctx, app, nav }) => {
  // Stop the button's loading spinner now instead of when the job is done.
  await app.answer(ctx, '⏳ Working on it…');
  try {
    const text = await app.queue('ai', () => slowModel('a poem about tea'), { ctx });
    return { text, parseMode: 'plain', keyboard: [[nav.self('🔁 Another one'), nav.home()]] };
  } catch (error) {
    return { text: busyText(error), keyboard: [[nav.home()]] };
  }
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/queue.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  queues: {
    // 2 jobs at a time; 1 per user; at most 20 waiting; give up after 2 minutes.
    ai: { concurrency: 2, perUser: 1, maxWaiting: 20, timeoutMs: 120_000 },
  },
}).register(home, poem);

// Tell users who have to wait where they are in line.
app.on('queueWait', async ({ ctx, position }) => {
  if (ctx?.chat) await ctx.api.sendMessage(ctx.chat.id, `⏳ You are number ${position ?? '?'} in the queue…`).catch(() => {});
});

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));

// Outside pages: take a slot for the rest of this update with enterQueue.
bot.command('ask', async (ctx) => {
  const question = ctx.match.trim();
  if (!question) return void (await ctx.reply('Usage: /ask <question>'));
  try {
    await app.enterQueue(ctx, 'ai'); // released automatically when this handler is done
  } catch (error) {
    return void (await ctx.reply(busyText(error)));
  }
  await ctx.replyWithChatAction('typing');
  await ctx.reply(await slowModel(question));
});
bot.catch((err) => console.error('Bot error:', err.error));

function busyText(error: unknown) {
  if (error instanceof QueueFullError) {
    return error.reason === 'perUser' ? 'You already have a job running, wait for it to finish.' : 'Too busy right now, try again in a minute.';
  }
  if (error instanceof QueueTimeoutError) return 'That took too long, sorry. Try again later.';
  throw error;
}

await startConcurrently(bot);

/** Handle updates concurrently with @grammyjs/runner when it is installed, else fall back to bot.start(). */
async function startConcurrently(bot: Bot<Context>) {
  const onStart = (me: { username: string }) => console.log(`@${me.username} is running. Send /start in Telegram.`);
  try {
    const { run } = (await import(String('@grammyjs/runner'))) as { run: (bot: Bot<Context>) => { stop(): Promise<void> } };
    await bot.init();
    const runner = run(bot);
    onStart(bot.botInfo);
    const stop = () => void runner.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    console.warn('@grammyjs/runner is not installed: updates are handled one at a time (bun add @grammyjs/runner).');
    process.once('SIGINT', () => bot.stop());
    process.once('SIGTERM', () => bot.stop());
    await bot.start({ onStart });
  }
}
