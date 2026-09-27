/**
 * Paid video lessons: members watch videos copied from a private storage
 * channel, others request access and an admin approves it.
 *
 *   BOT_TOKEN=123:abc ADMIN_ID=<your user id> STORAGE_CHAT_ID=-100… LESSON_IDS=2,3,4 \
 *   ADMIN_CHAT_ID=-100… SECRET=some-long-random-secret bun run examples/course.ts
 *
 * - STORAGE_CHAT_ID: a channel the bot is admin of, with one video per lesson;
 *   LESSON_IDS are the message ids of those videos, in order.
 * - ADMIN_CHAT_ID: a group (with the bot) where access requests arrive.
 *
 * Shows: `copy` + `protectContent`, per-button `{ mode: 'send' }` (the video
 * stays), `.params(parse)`, signed buttons, access middlewares, a
 * `prepareProactive` hook, `sendTo` with `allowedUsers`, `app.edit`, and the
 * `sent` event for auto-deleting videos.
 */
import { Bot, type Context } from 'grammy';
import { EasyTG, InvalidParamsError, md, withContext, type Middleware } from '../src';

const env = process.env;
if (!env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN. See the top of examples/course.ts for the variables to set.');
  process.exit(1);
}
const ADMIN_ID = Number(env.ADMIN_ID ?? 0);
const ADMIN_CHAT_ID = Number(env.ADMIN_CHAT_ID ?? ADMIN_ID);
const STORAGE_CHAT_ID = env.STORAGE_CHAT_ID ?? '';
const LESSON_IDS = (env.LESSON_IDS ?? '2,3,4').split(',').map(Number);
const VIDEO_TTL_MS = 30 * 60 * 1000; // videos disappear after 30 minutes

// ---- "database" --------------------------------------------------------------

type Role = 'guest' | 'pending' | 'member';
interface User {
  id: number;
  name: string;
  role: Role;
  /** Where the user's menu is, to refresh it with app.edit when access changes. */
  menu?: { chatId: number; messageId: number };
}
const db = new Map<number, User>();
const loadUser = (id: number, name = 'there') => {
  if (!db.has(id)) db.set(id, { id, name, role: id === ADMIN_ID ? 'member' : 'guest' });
  return db.get(id)!;
};

// Every handler and page sees `ctx.user`: set by a grammY middleware for
// updates, and by `prepareProactive` for sendTo / edit / broadcast.
type Ctx = Context & { user: User };
const { page } = withContext<Ctx>();

const lessons = LESSON_IDS.map((messageId, i) => ({ n: i + 1, title: `Lesson ${i + 1}`, messageId }));

const lessonNumber = (raw: string | undefined) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > lessons.length) throw new InvalidParamsError(`no lesson ${raw}`);
  return n;
};

// ---- access control ------------------------------------------------------------

const membersOnly: Middleware<Ctx> = ({ ctx, nav }, next) => (ctx.user.role === 'member' ? next() : nav.redirect(locked));
const adminOnly: Middleware<Ctx> = ({ ctx }, next) => (ctx.from?.id === ADMIN_ID ? next() : { text: '⛔ Admins only.' });

// ---- pages -----------------------------------------------------------------------

const home = page('home').render(({ ctx, nav }) => ({
  text: [
    md`Hi **${ctx.user.name}**!`,
    ctx.user.role === 'member' ? `You have access to ${lessons.length} lessons.` : 'Get access to watch the lessons.',
  ],
  keyboard: [
    ctx.user.role === 'member' && [nav.button('🎬 Lessons', lessonList)],
    ctx.user.role === 'guest' && [nav.button('🔑 Request access', requestAccess)],
    ctx.user.role === 'pending' && [nav.button('⏳ Waiting for approval…', home)],
  ],
}));

const locked = page('locked').render(({ nav }) => ({
  text: '🔒 This is for members only.',
  keyboard: [[nav.home()]],
}));

const lessonList = page('lessons')
  .use(membersOnly)
  .render(({ nav }) => ({
    text: '**Lessons**',
    keyboard: [...lessons.map((l) => [nav.button(`▶️ ${l.title}`, lesson, { n: l.n })]), [nav.back()]],
  }));

// The video is copied from the storage channel (no re-upload, no forward
// header) and protected from forwarding and saving. Its buttons send new
// messages, so the video stays in the chat until it expires.
const lesson = page<{ n: string }>('lesson')
  .use(membersOnly)
  .params((raw) => ({ n: lessonNumber(raw.n) }))
  .render(({ params, nav }) => {
    const current = lessons[params.n - 1]!;
    const next = lessons[params.n];
    return {
      copy: { fromChatId: STORAGE_CHAT_ID, messageId: current.messageId },
      protectContent: true,
      text: md`**${current.title}**\n\n⏳ Available for ${VIDEO_TTL_MS / 60000} minutes.`,
      keyboard: [
        next && [nav.button(`⏭ ${next.title}`, lesson, { n: next.n }, { mode: 'send' })],
        [nav.button('📂 All lessons', lessonList, {}, { mode: 'send' })],
      ],
    };
  });

// ---- access requests: a card in the admin group --------------------------------

const requestAccess = page('request').render(({ ctx, nav }) => {
  ctx.user.role = 'pending';
  const menu = ctx.callbackQuery?.message;
  if (menu) ctx.user.menu = { chatId: menu.chat.id, messageId: menu.message_id };
  // Rendered for the admin (so `adminOnly` passes), and only the admin may press
  // its buttons, even in a busy group. With several admins, list them all.
  app
    .sendTo(bot, { chatId: ADMIN_CHAT_ID, userId: ADMIN_ID, allowedUsers: [ADMIN_ID] }, reviewCard, { user: ctx.user.id })
    .catch((error) => console.error('Could not notify the admins:', error));
  return nav.redirect(home);
});

const reviewCard = page<{ user: string; decision?: 'approve' | 'reject' }>('review')
  .use(adminOnly)
  .params((raw) => ({ user: db.get(Number(raw.user)), decision: raw.decision }))
  .render(async ({ params, nav }) => {
    const user = params.user;
    if (!user) return { text: 'Unknown user.' };
    if (params.decision && user.role === 'pending') {
      user.role = params.decision === 'approve' ? 'member' : 'guest';
      // Refresh the user's own menu in place, and tell them.
      if (user.menu) await app.edit(bot, { ...user.menu, userId: user.id }, home);
      await app.sendTo(bot, user.id, decisionNotice, { approved: params.decision === 'approve' ? '1' : '0' });
    }
    return {
      text: [md`**Access request** from ${user.name} (\`${user.id}\`)`, `Status: ${user.role}`],
      keyboard: user.role === 'pending' && [
        [
          nav.self('✅ Approve', { user: user.id, decision: 'approve' }),
          nav.self('❌ Reject', { user: user.id, decision: 'reject' }),
        ],
      ],
    };
  });

const decisionNotice = page<{ approved: string }>('decision').render(({ params, nav }) => ({
  text: params.approved === '1' ? '🎉 Your access was approved!' : 'Sorry, your request was declined.',
  keyboard: [[nav.home('Open')]],
}));

// ---- app ------------------------------------------------------------------------

const bot = new Bot<Ctx>(env.BOT_TOKEN);
const app = new EasyTG<Ctx>({
  // Params are signed: buttons can't be forged, and nothing is stored per render.
  buttons: { params: 'signed', secret: env.SECRET ?? 'change-me-to-a-long-random-secret' },
  // sendTo / edit / broadcast contexts have `ctx.from` only when a user is given.
  prepareProactive: (ctx) => {
    if (ctx.from) ctx.user = loadUser(ctx.from.id);
  },
}).register(home, locked, lessonList, lesson, requestAccess, reviewCard, decisionNotice);

// Auto-delete lesson videos after a while (a job queue would survive restarts).
app.on('sent', ({ ctx, chatId, messageIds, page }) => {
  if (page !== 'lesson') return;
  setTimeout(() => ctx.api.deleteMessages(chatId, messageIds).catch(() => {}), VIDEO_TTL_MS);
});

bot.use((ctx, next) => {
  if (ctx.from) ctx.user = loadUser(ctx.from.id, ctx.from.first_name);
  return next();
});
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
