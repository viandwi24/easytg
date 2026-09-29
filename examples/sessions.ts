/**
 * The three kinds of session.
 *
 *   BOT_TOKEN=123:abc bun run examples/sessions.ts
 *
 * Use /start in a private chat and in a group (add the bot to one), press the
 * buttons in both places, and watch which numbers follow you and which don't:
 *
 * - `session`            this user in THIS chat. Separate in the private chat
 *                        and in each group. Also where easytg keeps dialogues
 *                        and the Back history, so they never mix between chats.
 * - `app.userSession()`  this user in EVERY chat: points, a plan, a language.
 * - `app.chatSession()`  this chat, shared by all its users: a group's settings,
 *                        a common counter.
 *
 * All three are loaded once per update and saved at its end. The user and
 * chat sessions can be changed by several updates at once (you in two chats,
 * two users in a group): only the keys an update changed are written, so
 * nothing else is lost.
 */
import { Bot } from 'grammy';
import { EasyTG, md, page } from '../src';

// Optional: declare your keys once and `get` / `set` are typed everywhere.
declare module '../src' {
  interface SessionData {
    clicksHere: number;
    points: number;
    groupTotal: number;
  }
}

const home = page<{ add?: 'here' | 'points' | 'group' }>('home').render(async ({ ctx, params, session, app, nav }) => {
  const user = await app.userSession(ctx);
  const chat = await app.chatSession(ctx);

  if (params.add === 'here') session.set('clicksHere', (session.get('clicksHere') ?? 0) + 1);
  if (params.add === 'points') user.set('points', (user.get('points') ?? 0) + 1);
  if (params.add === 'group') chat.set('groupTotal', (chat.get('groupTotal') ?? 0) + 1);

  return {
    text: [
      md`**Sessions of ${ctx.from?.first_name ?? 'you'}** in ${ctx.chat?.type === 'private' ? 'the private chat' : 'this group'}`,
      '',
      `📍 Your clicks in this chat: ${session.get('clicksHere') ?? 0}  _(session)_`,
      `⭐ Your points everywhere: ${user.get('points') ?? 0}  _(userSession)_`,
      `👥 This chat's total: ${chat.get('groupTotal') ?? 0}  _(chatSession)_`,
    ],
    keyboard: [
      [nav.self('📍 +1 here', { add: 'here' })],
      [nav.self('⭐ +1 point', { add: 'points' })],
      [nav.self('👥 +1 for the chat', { add: 'group' })],
    ],
  };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/sessions.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  // Everyone in a group may press the shared menu (by default only its owner may).
  buttons: { ownerOnly: false },
}).register(home);

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start here and in a group.`) });
