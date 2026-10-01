/**
 * Table reservations: a dialogue with a calendar, a number picker and
 * several-options-at-once.
 *
 *   BOT_TOKEN=123:abc bun run examples/booking.ts
 *
 * Shows: `date` (an inline calendar from today to 60 days ahead, month and day
 * names in the user's language), `number` (guests with ➖ / ➕, or typed),
 * `multiChoice` (extras, toggled with ✅, then Done), a prompt that shows the
 * chosen day, `when`, typed answers in `onFinish`, and `app.command`.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page } from '../src';

/** Stands in for your database. */
const bookings: Array<{ userId: number; day: string; time: string; guests: number; extras: string[]; note?: string }> = [];

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const weekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00`).getDay());
const prettyDate = (day: string, locale?: string) =>
  new Intl.DateTimeFormat(locale ?? 'en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00`));

const book = dialogue('book')
  .steps([
    // Answer: 'YYYY-MM-DD'. Functions are evaluated each time, so "today" stays today.
    { id: 'day', type: 'date', text: '📅 Which day?', min: () => new Date(), max: () => inDays(60) },
    {
      id: 'time',
      type: 'choice',
      text: ({ answers, locale }) => md`🕐 What time on **${prettyDate(answers.day as string, locale)}**?`,
      columns: 3,
      options: ['18:00', '19:00', '20:00', '21:00'].map((t) => ({ text: t, value: t })),
    },
    // Answer: a number. Typing "6" works too.
    { id: 'guests', type: 'number', text: '👥 How many guests?', min: 1, max: 12, initial: 2, format: (n) => `${n} ${n === 1 ? 'guest' : 'guests'}` },
    {
      id: 'extras',
      type: 'multiChoice',
      text: '✨ Anything else? Pick all that apply.',
      columns: 2,
      min: 0,
      options: [
        { text: '🪟 Window seat', value: 'window' },
        { text: '🎂 Birthday', value: 'birthday' },
        { text: '👶 High chair', value: 'highchair' },
        { text: '♿ Step-free', value: 'stepfree' },
      ],
    },
    // Asked only for birthdays.
    { id: 'note', type: 'text', text: '🎂 Whose birthday? We will bring a candle.', when: ({ answers }) => (answers.extras as string[]).includes('birthday') },
  ])
  .onFinish(({ ctx, answers, locale, nav }) => {
    // answers: { day: string; time: '18:00' | …; guests: number; extras: ('window' | …)[]; note?: string }
    bookings.push({ userId: ctx.from!.id, ...answers });
    return {
      text: [
        '✅ **Booked!**',
        md`${prettyDate(answers.day, locale)} at ${answers.time}, ${answers.guests} guests`,
        answers.extras.length ? md`Extras: ${answers.extras.join(', ')}` : '',
        answers.note ? md`Birthday: ${answers.note} 🎂` : '',
        weekend(answers.day) ? '_It is a weekend: please arrive on time._' : '',
      ],
      keyboard: [[nav.button('📋 My bookings', mine)], [nav.home()]],
    };
  })
  .onCancel(({ nav }) => nav.redirect(home));

const home = page('home').render(({ nav }) => ({
  text: ['🍽 **Table reservations**', 'Book a table in a few taps.'],
  keyboard: [[nav.button('📅 Book a table', book)], [nav.button('📋 My bookings', mine)]],
}));

const mine = page('mine').render(({ ctx, locale, nav }) => {
  const list = bookings.filter((b) => b.userId === ctx.from?.id);
  return {
    text: ['📋 **My bookings**', ...(list.length ? list.map((b) => md`- ${prettyDate(b.day, locale)}, ${b.time}, ${b.guests} guests`) : ['None yet.'])],
    keyboard: [[nav.button('📅 Book a table', book)], [nav.home()]],
  };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/booking.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG()
  .command('start', home, { description: 'Main menu' })
  .command('book', book, { description: 'Book a table' })
  .command('bookings', mine, { description: 'My bookings' });

bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
