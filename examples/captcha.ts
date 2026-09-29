/**
 * Captcha example: a button captcha (pages) and a typed captcha (dialogue).
 *
 *   BOT_TOKEN=123:abc bun run examples/captcha.ts
 *
 * Commands: /start
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/captcha.ts');
  process.exit(1);
}

const MAX_ATTEMPTS = 3;

interface Challenge {
  question: string;
  answer: number;
  options: number[];
  attempts: number;
}

function newChallenge(): Challenge {
  const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
  const a = randomInt(1, 9);
  const b = randomInt(1, 9);
  const options = new Set([a + b]);
  while (options.size < 4) options.add(randomInt(2, 18));
  return { question: `${a} + ${b}`, answer: a + b, options: [...options].sort(() => Math.random() - 0.5), attempts: 0 };
}

// ---- pages (they can reference each other, in any order) -------------------

const home = page('home').render(({ ctx, session, nav }) => {
  const verified = session.get<boolean>('verified');
  return {
    // md`` escapes interpolated values: a user named "*[x](evil)*" stays plain text.
    text: [
      md`Hi **${ctx.from?.first_name ?? 'there'}**!`,
      '',
      verified ? '✅ You are verified.' : 'Prove you are human to continue.',
    ],
    keyboard: [
      [nav.button('🔘 Button captcha', buttonCaptcha, { fresh: 1 })],
      [nav.button('⌨️ Typed captcha', typedCaptcha)], // starts the dialogue
      verified && [nav.button('♻️ Reset', reset)],
      [nav.close()],
    ],
  };
});

// The correct answer never goes into callback data: buttons only carry the
// chosen value, the expected answer stays server-side in the session.
const buttonCaptcha = page<{ fresh?: string }>('captcha').render(({ params, session, nav }) => {
  let challenge = session.get<Challenge>('captcha');
  if (!challenge || params.fresh) {
    challenge = newChallenge();
    session.set('captcha', challenge, { ttlMs: 5 * 60_000 }); // an abandoned captcha expires by itself
  }
  return {
    text: ['**Button captcha**', '', `What is ${challenge.question}?`, `Attempts left: ${MAX_ATTEMPTS - challenge.attempts}`],
    keyboard: [challenge.options.map((value) => nav.button(String(value), check, { v: value })), [nav.home()]],
  };
});

const check = page<{ v: string }>('captcha_check').render(({ params, session, nav }) => {
  const challenge = session.get<Challenge>('captcha');
  if (!challenge) {
    return { text: 'This captcha has expired.', keyboard: [[nav.button('New captcha', buttonCaptcha, { fresh: 1 })]] };
  }

  if (Number(params.v) === challenge.answer) {
    session.delete('captcha');
    session.set('verified', true);
    return { text: '🎉 Correct, you are verified!', toast: 'Verified', keyboard: [[nav.home()]] };
  }

  challenge.attempts += 1;
  if (challenge.attempts >= MAX_ATTEMPTS) {
    session.delete('captcha');
    return {
      text: '❌ Too many wrong answers.',
      keyboard: [[nav.button('Try again', buttonCaptcha, { fresh: 1 })], [nav.home()]],
    };
  }
  session.set('captcha', challenge, { ttlMs: 5 * 60_000 });
  return {
    text: `❌ Wrong answer. Attempts left: ${MAX_ATTEMPTS - challenge.attempts}`,
    keyboard: [[nav.button('Retry', buttonCaptcha)], [nav.home()]],
  };
});

const reset = page('reset').render(({ session, nav }) => {
  session.delete('verified', 'captcha');
  return { text: 'Verification reset.', keyboard: [[nav.home()]] };
});

// ---- dialogue --------------------------------------------------------------

// Each time the prompt is shown a new challenge is generated and kept in the
// session, so a wrong answer gets a fresh question.
const typedCaptcha = dialogue<{ answer: string }>('typed')
  .steps([
    {
      id: 'answer',
      type: 'text',
      text: ({ session }) => {
        const challenge = newChallenge();
        session.set('typed', challenge, { ttlMs: 5 * 60_000 });
        return ['**Typed captcha**', '', `Type the result of ${challenge.question}:`];
      },
      validate: (value, { session }) => {
        if (!/^\s*\d+\s*$/.test(value)) return 'Please send a number.';
        return Number(value) === session.get<Challenge>('typed')?.answer || 'Wrong answer, try again.';
      },
    },
  ])
  .onFinish(({ session, nav }) => {
    session.delete('typed');
    session.set('verified', true);
    return { text: '🎉 Correct, you are verified!', keyboard: [[nav.home()]] };
  })
  // Cancel shows the home menu in place of the prompt.
  .onCancel(({ session, nav }) => {
    session.delete('typed');
    return nav.redirect(home);
  });

// ---- wiring ----------------------------------------------------------------

const bot = new Bot(token);
const app = new EasyTG().register(home, buttonCaptcha, check, reset, typedCaptcha);

bot.use(app); // first: handles easytg buttons, dialogue input and saves sessions
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
