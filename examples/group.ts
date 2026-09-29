/**
 * A group bot: settings only admins can change, a live scoreboard, and a quiz
 * question that times out.
 *
 *   BOT_TOKEN=123:abc bun run examples/group.ts
 *
 * Add the bot to a group, then use /settings, /board and /quiz there. Quiz
 * answers are plain messages: turn off the bot's privacy mode in @BotFather
 * (/setprivacy), or answer by replying to the question.
 *
 * Shows: `app.chatSession` (state shared by the whole chat), `requireChatAdmin`,
 * `refreshEveryMs` (the scoreboard re-renders itself), `dialogue(...).timeout`,
 * and `buttons.ownerOnly: false` so everyone may press shared menus.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page, requireChatAdmin } from '../src';

interface Settings {
  quizzes: boolean;
}

const settings = page<{ toggle?: string }>('settings')
  .use(requireChatAdmin()) // non-admins get a toast; admins pass
  .render(async ({ ctx, params, app, nav }) => {
    const chat = await app.chatSession(ctx);
    const current = chat.get<Settings>('settings') ?? { quizzes: true };
    if (params.toggle) chat.set('settings', { quizzes: !current.quizzes });
    const quizzes = params.toggle ? !current.quizzes : current.quizzes;
    return {
      text: ['**Group settings**', `Quizzes: ${quizzes ? 'on' : 'off'}`],
      keyboard: [[nav.self(quizzes ? 'Turn quizzes off' : 'Turn quizzes on', { toggle: '1' })], [nav.close()]],
    };
  });

// Re-rendered every 10 s while the message shows it: scores change as people answer.
const board = page('board').render(async ({ ctx, app, nav }) => {
  const scores = (await app.chatSession(ctx)).get<Record<string, number>>('scores') ?? {};
  const lines = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([name, score], i) => md`${i + 1}. ${name}: ${score}`);
  return {
    text: ['🏆 **Scoreboard**', ...(lines.length ? lines : ['No points yet. Try /quiz!']), '', `_Updated ${new Date().toLocaleTimeString()}_`],
    refreshEveryMs: 10_000,
    keyboard: [[nav.self('🔄 Refresh')]],
  };
});

// Each quiz waits 60 s for an answer, then gives up (onCancel runs, reason 'timeout').
const quiz = dialogue<{ answer: string }>('quiz')
  .timeout(60_000)
  .steps([{ id: 'answer', type: 'text', text: 'Quiz: what is 7 × 6? (60 seconds)' }])
  .onFinish(async ({ ctx, answers, app }) => {
    if (answers.answer.trim() !== '42') return { text: '❌ Not quite. Try /quiz again.' };
    const chat = await app.chatSession(ctx);
    const scores = chat.get<Record<string, number>>('scores') ?? {};
    const name = ctx.from?.first_name ?? 'someone';
    chat.set('scores', { ...scores, [name]: (scores[name] ?? 0) + 1 });
    return { text: md`✅ Correct, ${name}! +1 point.` };
  });

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/group.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  // Menus in this group are shared: anyone may press them (admin pages check for themselves).
  buttons: { ownerOnly: false },
  dialogues: { timeoutMs: 10 * 60_000 },
}).register(settings, board, quiz);
app.on('dialogueCancel', ({ reason, dialogue }) => reason === 'timeout' && console.log(`${dialogue} timed out`));

bot.use(app);
bot.command('settings', (ctx) => app.open(ctx, settings));
bot.command('board', (ctx) => app.open(ctx, board));
bot.command('quiz', async (ctx) => {
  const chat = await app.chatSession(ctx);
  if (chat.get<Settings>('settings')?.quizzes === false) return void (await ctx.reply('Quizzes are off in this group.'));
  await app.startDialogue(ctx, quiz);
});
bot.catch((err) => console.error('Bot error:', err.error));

const stopScheduler = app.startScheduler(bot); // runs the scoreboard refreshes
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Add it to a group.`) });
await stopScheduler();
