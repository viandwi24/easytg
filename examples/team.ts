/**
 * A team bot for a group, where some things are everyone's and some are
 * yours alone: ephemeral messages (Bot API 10.2) show a page to one member
 * only, right in the group.
 *
 *   BOT_TOKEN=123:abc bun run examples/team.ts
 *
 * Add the bot to a group (as an admin, so it may answer ephemerally at any
 * time), then:
 * - /board: the shared team board. "⚙️ My settings" and "🗳 Vote for lunch"
 *   open for the presser only, in place of the board on their screen; the
 *   others keep seeing the board. "📊 Lunch results" is for everyone.
 * - /task <text> and /mytasks: ephemeral commands; nobody else sees them,
 *   nor the answers.
 *
 * Shows: `{ mode: 'ephemeral' }` on buttons (a page and a dialogue), a page
 * whose buttons edit the ephemeral copy, `app.command(…, { ephemeral: true })`
 * with `syncCommands`, `nav.disabled` for a button that is visible but off,
 * and `userSession` / `chatSession` for what is yours and what is the team's.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page } from '../src';

const dishes = [
  { text: '🍕 Pizza', value: 'pizza' },
  { text: '🍣 Sushi', value: 'sushi' },
  { text: '🥗 Salad', value: 'salad' },
  { text: '🍜 Ramen', value: 'ramen' },
] as const;

const board = page('board').render(({ ctx, nav }) => {
  if (ctx.chat?.type === 'private') return { text: 'Add me to a group and send /board there.' };
  return {
    text: ['📋 **Team board**', 'Settings and votes are yours alone: they open just for you.'],
    keyboard: [
      [nav.button('⚙️ My settings', settings, {}, { mode: 'ephemeral' })],
      [nav.button('🗳 Vote for lunch', vote, {}, { mode: 'ephemeral' })],
      [nav.button('📊 Lunch results', results)],
    ],
  };
});

// Opened ephemerally: only the presser sees it, and its buttons edit their own copy.
const settings = page<{ toggle?: string }>('settings').render(async ({ ctx, app, params, nav }) => {
  const mine = await app.userSession(ctx);
  if (params.toggle === 'notify') mine.set('notify', !(mine.get<boolean>('notify') ?? true));
  const notify = mine.get<boolean>('notify') ?? true;
  const member = ctx.chat ? await ctx.api.getChatMember(ctx.chat.id, ctx.from!.id) : undefined;
  const admin = member?.status === 'creator' || member?.status === 'administrator';
  return {
    text: md`⚙️ **Settings of ${ctx.from?.first_name ?? 'you'}**\nOnly you can see this.`,
    keyboard: [
      [nav.self(notify ? '🔔 Notifications: on' : '🔕 Notifications: off', { toggle: 'notify' })],
      // Visible to everyone, usable by admins: greyed out for the others.
      [admin ? nav.button('🛠 Admin tools', adminTools) : nav.disabled('🛠 Admin tools 🔒')],
      [nav.close('✖️ Close')],
    ],
  };
});

const adminTools = page('admin-tools').render(({ nav }) => ({ text: '🛠 Admin tools (only you see this).', keyboard: [[nav.back()]] }));

// A dialogue started ephemerally: its questions and its answer go to the voter only.
const vote = dialogue('lunch-vote')
  .steps([{ id: 'picks', type: 'multiChoice', text: '🗳 What would you like? (up to 2)', columns: 2, max: 2, options: dishes }])
  .onFinish(async ({ ctx, app, answers }) => {
    const team = await app.chatSession(ctx);
    const votes = team.get<Record<string, string[]>>('lunch') ?? {};
    team.set('lunch', { ...votes, [String(ctx.from!.id)]: answers.picks });
    return { text: md`✅ You voted for ${answers.picks.map((p) => dishes.find((d) => d.value === p)!.text).join(' and ')}. Only you can see this.` };
  });

const results = page('results').render(async ({ ctx, app, nav }) => {
  const votes = (await app.chatSession(ctx)).get<Record<string, string[]>>('lunch') ?? {};
  const counts = dishes.map((d) => ({ ...d, n: Object.values(votes).filter((v) => v.includes(d.value)).length }));
  return {
    text: ['📊 **Lunch results**', ...counts.map((d) => `${d.text}: ${'▇'.repeat(d.n)} ${d.n}`), `${Object.keys(votes).length} voter(s)`],
    keyboard: [[nav.back()]],
  };
});

// Personal tasks, through ephemeral commands: the group never sees them.
const addTask = page<{ text?: string }>('add-task').render(async ({ ctx, app, params, nav }) => {
  const mine = await app.userSession(ctx);
  if (!params.text) return { text: 'Usage: /task buy coffee' };
  mine.set('tasks', [...(mine.get<string[]>('tasks') ?? []), params.text]);
  return nav.redirect(myTasks);
});

const myTasks = page('my-tasks').render(async ({ ctx, app }) => {
  const tasks = (await app.userSession(ctx)).get<string[]>('tasks') ?? [];
  return { text: ['📝 **Your tasks** (only you can see this)', ...(tasks.length ? tasks.map((t) => md`- ${t}`) : ['None yet: /task …'])] };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/team.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({ buttons: { ownerOnly: false } }) // the board is everyone's
  .register(settings, adminTools, vote, results)
  .command('board', board, { description: 'The team board' })
  .command('start', board)
  .command('task', addTask, { description: 'Add a task (only you see it)', ephemeral: true, chats: 'groups', params: (text) => ({ text }) })
  .command('mytasks', myTasks, { description: 'Your tasks (only you see them)', ephemeral: true, chats: 'groups' });

bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Add it to a group and send /board.`) });
