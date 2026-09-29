/**
 * Slow work without leaving users wondering: loading indicators.
 *
 *   BOT_TOKEN=123:abc bun run examples/loading.ts
 *
 * Every indicator waits `afterMs` (default 500 ms) first: work that finishes
 * sooner shows nothing at all, so fast pages don't flicker. Then, until the
 * work is done:
 * - `text`:   a placeholder. A pressed text menu shows it (without buttons, so
 *             it can't be pressed twice); otherwise it is sent as a message.
 *             The result then replaces it.
 * - `action`: a chat action ("typing…", "sending photo…"), repeated until done.
 * - `toast`:  a small popup on the pressed button.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, page } from '../src';

/** Stands in for an AI model, a report, a slow API… */
const slow = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const home = page('home').render(({ nav }) => ({
  text: ['**Loading indicators**', 'Each button takes a few seconds:'],
  keyboard: [
    [nav.button('🤖 Ask the robot', answer)],
    [nav.button('📊 Build a report', report)],
    [nav.button('⚡ A fast page', fast)],
    [nav.button('📝 A form with a slow ending', feedback)],
  ],
}));

// Placeholder + "typing…" + a toast: the most complete feedback.
const answer = page('answer')
  .loading({ text: '🤖 Thinking…', action: 'typing', toast: 'On it!' })
  .render(async ({ nav }) => ({
    text: await slow(3000, 'The answer is 42.'),
    keyboard: [[nav.back()]],
  }));

// A string is a placeholder only.
const report = page('report')
  .loading('📊 Building your report, this takes a few seconds…')
  .render(async ({ nav }) => ({
    text: ['**Report**', ...(await slow(4000, ['Sales: 120', 'Returns: 3', 'Rating: 4.8']))],
    keyboard: [[nav.back()]],
  }));

// Fast pages show nothing, even with the app-wide default below.
const fast = page('fast').render(({ nav }) => ({ text: 'This one was instant.', keyboard: [[nav.back()]] }));

// Dialogues: the indicator covers a slow onFinish (e.g. saving to a CRM).
const feedback = dialogue<{ text: string }>('feedback')
  .loading({ text: '📨 Sending your feedback…', action: 'typing' })
  .steps([{ id: 'text', type: 'text', text: 'What do you think of this bot?' }])
  .onFinish(async ({ nav }) => {
    await slow(2500, undefined);
    return { text: '✅ Thanks, your feedback was sent.', keyboard: [[nav.home()]] };
  });

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/loading.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  // A default for every page without its own `.loading(...)`: "typing…" when
  // a render takes longer than 800 ms. `.loading(false)` on a page turns it off.
  loading: { action: 'typing', afterMs: 800 },
}).register(home, answer, report, fast, feedback);

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));

// Outside pages, wrap your own slow work with app.withLoading. Its placeholder
// is deleted when the work is done, so you reply however you like.
bot.command('translate', async (ctx) => {
  const text = ctx.match || 'hello';
  const result = await app.withLoading(ctx, () => slow(2500, text.split('').reverse().join('')), {
    text: '🌐 Translating…',
    action: 'typing',
  });
  await ctx.reply(`Translation: ${result}`);
});

bot.catch((err) => console.error('Bot error:', err.error));
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start or /translate <text>.`) });
