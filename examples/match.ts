/**
 * A "meet new people" bot, like the dating bots on Telegram: profile cards
 * with a photo, and a reply keyboard to react: ❤️ like, 💌 like with a
 * message, 👎 skip, 💤 take a break. Mutual likes are a match.
 *
 *   BOT_TOKEN=123:abc bun run examples/match.ts
 *
 * /start asks for a short profile first (a dialogue), then shows people one by
 * one. The demo profiles are made up; real users of the bot see each other
 * too: when someone likes you, you get a message and can like them back. Try
 * it with two accounts (in the playground: switch the user at the top).
 *
 * A match with a real user can chat anonymously: messages go through the
 * bot (`app.relay`), so neither sees the other's account; /end stops.
 *
 * Shows: a reply-keyboard menu whose buttons act on the card on screen (kept
 * in the session), `app.showMenu` / `app.hideMenu` from renders, a dialogue
 * with a `when` step and a photo upload, a dialogue started from the menu,
 * `app.sendTo` to notify other users, `app.relay` for anonymous chats, and
 * `app.command` + `app.syncCommands` for the command menu.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page, replyMenu } from '../src';

interface Profile {
  id: number;
  name: string;
  age: number;
  bio: string;
  /** A URL or a Telegram file_id. */
  photo: string;
  km: number;
  /** Demo profiles aren't real users; `likesBack` decides whether they match. */
  demo?: { likesBack: boolean };
}

// Cartoon avatars, so no real person's photo is used.
const avatar = (seed: string) => `https://api.dicebear.com/9.x/lorelei/png?seed=${encodeURIComponent(seed)}&size=512&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;

// Stands in for your database: profiles and who liked whom.
const profiles = new Map<number, Profile>(
  [
    { name: 'Nadia', age: 22, bio: 'coffee, films and long walks ☕️', likesBack: true },
    { name: 'Raka', age: 24, bio: 'guitar at night, football on weekends ⚽️', likesBack: false },
    { name: 'Salsa', age: 20, bio: 'cat person 🐈 looking for a study buddy', likesBack: true },
    { name: 'Dimas', age: 23, bio: 'I cook better than I text', likesBack: false },
    { name: 'Tika', age: 21, bio: 'photos, sunsets, and more photos 📸', likesBack: true },
    { name: 'Bima', age: 25, bio: 'mountains > beaches. fight me 🏔', likesBack: false },
  ].map((p, i) => [-(i + 1), { id: -(i + 1), name: p.name, age: p.age, bio: p.bio, photo: avatar(p.name), km: 1 + ((i * 3) % 9), demo: { likesBack: p.likesBack } }]),
);
const likes = new Map<number, Set<number>>(); // user id → ids they liked

const caption = (p: Profile) => md`${p.name}, ${p.age}, 📍 ${p.km} km${p.bio ? md` – ${p.bio}` : ''}`;

// ---- the profile card and the reaction keyboard ------------------------------

/** The next person this user hasn't reacted to yet; which one is on screen is kept in the session. */
const card = page('card').render(async ({ ctx, session, nav, app }) => {
  const me = ctx.from!.id;
  const seen = session.get<number[]>('seen') ?? [];
  // Real people first, then the demo profiles.
  const next = [...profiles.values()].sort((a, b) => Number(!!a.demo) - Number(!!b.demo)).find((p) => p.id !== me && !seen.includes(p.id));
  if (!next) {
    session.delete('viewing');
    await app.hideMenu(ctx, "That's everyone nearby for now 🙂");
    return nav.redirect(home);
  }
  session.set('viewing', next.id);
  return { photo: next.photo, text: caption(next) };
});

/** The profile on screen, marked as seen. */
function takeViewing(session: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }) {
  const id = session.get<number>('viewing');
  const profile = id === undefined ? undefined : profiles.get(id);
  if (profile) session.set('seen', [...(session.get<number[]>('seen') ?? []), profile.id]);
  return profile;
}

const like = page('like').render(async ({ ctx, session, nav }) => {
  const them = takeViewing(session);
  const me = profiles.get(ctx.from!.id);
  if (them && me) await sendLike(me, them);
  return nav.redirect(card);
});

const skip = page('skip').render(({ session, nav }) => {
  takeViewing(session);
  return nav.redirect(card);
});

const pause = page('pause').render(async ({ ctx, app, nav }) => {
  await app.hideMenu(ctx, '💤 Taking a break. Your profile stays visible to others.');
  return nav.redirect(home);
});

// 💌: a like with a message, asked for in a dialogue.
const note = dialogue('note')
  .steps([
    {
      id: 'text',
      type: 'text',
      text: ({ session }) => md`💌 Write a message for **${profiles.get(session.get<number>('viewing') ?? 0)?.name ?? 'them'}**`,
      validate: (text) => text.length <= 300 || 'Up to 300 characters, please.',
    },
  ])
  .onFinish(async ({ ctx, session, answers, nav }) => {
    const them = takeViewing(session);
    const me = profiles.get(ctx.from!.id);
    if (them && me) await sendLike(me, them, answers.text);
    return nav.redirect(card);
  })
  .onCancel(({ nav }) => nav.redirect(card));

const reactions = replyMenu(
  [[replyMenu.button('❤️', like), replyMenu.button('💌', note), replyMenu.button('👎', skip), replyMenu.button('💤', pause)]],
  { placeholder: 'Like, message, skip or pause' },
);

// ---- likes and matches ------------------------------------------------------

async function sendLike(from: Profile, to: Profile, message?: string) {
  const liked = likes.get(from.id) ?? new Set<number>();
  likes.set(from.id, liked.add(to.id));
  const mutual = to.demo ? to.demo.likesBack : !!likes.get(to.id)?.has(from.id);
  if (mutual) {
    await app.sendTo(bot, from.id, matched, { id: String(to.id) });
    if (!to.demo) await app.sendTo(bot, to.id, matched, { id: String(from.id) });
  } else if (!to.demo) {
    // A real user: tell them, without saying who (they see it with "Show").
    await app.sendTo(bot, to.id, likedYou, { id: String(from.id), message: message ?? '' });
  }
}

const matched = page<{ id: string }>('matched').render(({ params, nav }) => {
  const them = profiles.get(Number(params.id));
  if (!them) return;
  return {
    photo: them.photo,
    text: [md`🎉 **It's a match with ${them.name}!**`, them.demo ? '(A demo profile, so there is no one to write to.)' : 'Say hi 👋'],
    keyboard: them.demo ? [] : [[nav.button('💬 Chat anonymously', chat, { id: params.id }, { mode: 'send' })]],
  };
});

// ---- anonymous chat between two matches ---------------------------------------

const chat = page<{ id: string }>('chat').render(async ({ ctx, params, app }) => {
  const them = profiles.get(Number(params.id));
  const me = profiles.get(ctx.from!.id);
  if (!them || !me || them.demo) return;
  await app.relay.start(ctx, me.id, them.id);
  // Both sides lose the ❤️ 💌 👎 💤 keyboard while chatting, so those labels are sent as messages.
  await app.hideMenu(ctx, md`💬 You're chatting with **${them.name}**. Send anything: it goes to them through the bot. /end to stop.`);
  await app.withUser(bot, them.id, ({ ctx: theirs }) =>
    app.hideMenu(theirs, md`💬 **${me.name}** started a chat with you. Messages you send go to them. /end to stop.`),
  );
});

const endChat = page('end-chat').render(async ({ ctx, app, nav }) => {
  const link = await app.relay.end(ctx, ctx.from!.id);
  if (!link) return { text: "You're not in a chat." };
  await app.sendTo(bot, link.peer, chatEnded);
  return nav.redirect(home);
});

const chatEnded = page('chat-ended').render(({ nav }) => ({
  text: '👋 The chat has ended.',
  keyboard: [[nav.button('🚀 Find people', browse, {}, { mode: 'send' })]],
}));

const likedYou = page<{ id: string; message?: string }>('liked-you').render(({ params, nav }) => ({
  text: ['💘 **Someone liked your profile!**', params.message ? md`They wrote: “${params.message}”` : ''],
  keyboard: [[nav.button('👀 Show', admirer, { id: params.id })]],
}));

const admirer = page<{ id: string }>('admirer').render(({ params, nav }) => {
  const them = profiles.get(Number(params.id));
  if (!them) return { text: 'This profile is gone.' };
  return {
    photo: them.photo,
    text: caption(them),
    keyboard: [[nav.button('❤️ Like back', likeBack, { id: params.id }), nav.close('👎')]],
  };
});

const likeBack = page<{ id: string }>('like-back').render(async ({ ctx, params, nav }) => {
  const them = profiles.get(Number(params.id));
  const me = profiles.get(ctx.from!.id);
  if (!them || !me) return;
  likes.set(me.id, (likes.get(me.id) ?? new Set<number>()).add(them.id));
  await app.sendTo(bot, them.id, matched, { id: String(me.id) });
  return nav.redirect(matched, { id: params.id }); // this message becomes the match
});

// ---- home, profile and sign-up -----------------------------------------------

const home = page('home').render(({ ctx, nav }) => {
  const me = profiles.get(ctx.from!.id);
  if (!me) return nav.startDialogue(signup);
  return {
    text: md`👋 Hi **${me.name}**! What now?`,
    keyboard: [
      [nav.button('🚀 Find people', browse, {}, { mode: 'send' })],
      [nav.button('👤 My profile', myProfile), nav.button('✏️ Edit', signup)],
    ],
  };
});

const browse = page('browse').render(async ({ ctx, session, app, nav }) => {
  session.delete('seen'); // start over
  await app.showMenu(ctx, '✨🔍');
  return nav.redirect(card);
});

const myProfile = page('my-profile').render(({ ctx, nav }) => {
  const me = profiles.get(ctx.from!.id);
  if (!me) return nav.startDialogue(signup);
  return { photo: me.photo, text: ['This is how others see you:', caption(me)], keyboard: [[nav.back(), nav.home()]] };
});

const signup = dialogue('signup')
  .steps([
    { id: 'name', type: 'text', text: "Let's make your profile. What's your name?", validate: (name) => (name.length >= 2 && name.length <= 30) || '2 to 30 characters, please.' },
    {
      id: 'age',
      type: 'text',
      text: 'How old are you?',
      validate: (age) => (/^\d+$/.test(age) && Number(age) >= 16 && Number(age) <= 99) || 'A number from 16 to 99, please.',
    },
    { id: 'bio', type: 'text', text: 'A few words about you (or "-" to skip):' },
    {
      id: 'photoChoice',
      type: 'choice',
      text: 'And a photo?',
      options: [
        { text: '📷 Send my own', value: 'own' },
        { text: '🎲 A cartoon avatar', value: 'avatar' },
      ],
    },
    { id: 'photo', type: 'file', accept: ['photo'], text: 'Send your photo 📎', when: ({ answers }) => answers.photoChoice === 'own' },
  ])
  .onFinish(({ ctx, answers, nav }) => {
    const id = ctx.from!.id;
    profiles.set(id, {
      id,
      name: answers.name,
      age: Number(answers.age),
      bio: answers.bio === '-' ? '' : answers.bio,
      photo: answers.photo?.fileId ?? avatar(`${answers.name}${id}`),
      km: 1 + (id % 5),
    });
    return nav.redirect(myProfile);
  })
  .onCancel(({ nav }) => nav.redirect(home));

// ---- wiring -----------------------------------------------------------------

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/match.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({ menu: reactions })
  .register(card, like, skip, pause, note, matched, likedYou, admirer, likeBack, chat, chatEnded, browse, signup)
  .command('start', home, { description: 'Main menu' })
  .command('profile', myProfile, { description: 'Your profile' })
  .command('end', endChat, { description: 'End the current chat' });

// The other person blocked the bot: tell the one who wrote.
app.on('relayEnd', async ({ ctx, reason }) => {
  if (reason === 'unreachable') await ctx?.reply('😕 They left the chat.');
});

bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot); // the command menu next to the message field

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
