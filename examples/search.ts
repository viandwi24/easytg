/**
 * A searchable catalog in two languages: `page.onText` and `i18n.messages`.
 *
 *   BOT_TOKEN=123:abc bun run examples/search.ts
 *
 * Open /start, press "Search" and type a word: the results replace the search
 * page (`mode: 'edit'`) and your message is deleted. Texts follow the
 * Telegram app's language (English or Indonesian), or the one picked under
 * "Language" (kept in the session).
 */
import { Bot } from 'grammy';
import { EasyTG, page, paginate, replyMenu } from '../src';
import { id as idTexts } from './locales/id';

const products = ['Green tea', 'Black tea', 'Jasmine tea', 'Espresso', 'Latte', 'Cappuccino', 'Cheesecake', 'Brownie', 'Croissant'];

// Your app's texts. Placeholders like {name} are filled in by t(); plural forms by {count}.
const messages = {
  en: {
    home: { title: 'Hi **{name}**! What are you looking for?', search: '🔎 Search', language: '🌐 Language' },
    search: {
      prompt: 'Type a product name.',
      results: { zero: 'Nothing found for **{query}**.', one: '1 product for **{query}**:', other: '{count} products for **{query}**:' },
      again: 'Type another word to search again.',
    },
    language: { title: 'Choose a language', saved: 'Language saved.' },
    menu: { search: '🔎 Search' },
  },
  id: {
    home: { title: 'Halo **{name}**! Cari apa hari ini?', search: '🔎 Cari', language: '🌐 Bahasa' },
    search: {
      prompt: 'Ketik nama produk.',
      results: { zero: 'Tidak ada hasil untuk **{query}**.', other: '{count} produk untuk **{query}**:' },
      again: 'Ketik kata lain untuk mencari lagi.',
    },
    language: { title: 'Pilih bahasa', saved: 'Bahasa disimpan.' },
    menu: { search: '🔎 Cari' },
  },
};

const home = page('home').render(({ ctx, t, nav }) => ({
  // t.md: the message is Markdown and {name} is escaped, so any name is safe.
  text: t.md('home.title', { name: ctx.from?.first_name ?? '' }),
  keyboard: [[nav.button(t('home.search'), search)], [nav.button(t('home.language'), language)]],
}));

const search = page<{ q?: string; page?: string }>('search')
  .render((args) => {
    const { params, t, nav } = args;
    if (!params.q) return { text: t('search.prompt'), keyboard: [[nav.home()]] };
    const query = params.q.toLowerCase();
    const found = products.filter((p) => p.toLowerCase().includes(query));
    const { offset, limit, buttons } = paginate(args, { total: found.length, perPage: 4 });
    return {
      text: [
        t.md('search.results', { count: found.length, query: params.q }),
        ...found.slice(offset, offset + limit).map((p) => `- ${p}`),
        '',
        t('search.again'),
      ],
      keyboard: [found.length > 4 && buttons, [nav.home()]],
    };
  })
  // While this page is the last one shown, the user's text lands here.
  .onText(({ text, nav }) => nav.redirect(search, { q: text.slice(0, 50) }), { mode: 'edit', deleteInput: true });

const language = page<{ set?: 'en' | 'id' }>('language').render(async ({ ctx, params, t, nav, app }) => {
  // Kept in the session, used at once (this very reply is in the new language)
  // and for everything sent to the user later.
  if (params.set === 'en' || params.set === 'id') await app.setLocale(ctx, params.set);
  return {
    text: params.set ? t('language.saved') : t('language.title'),
    keyboard: [[nav.self('🇬🇧 English', { set: 'en' }), nav.self('🇮🇩 Indonesia', { set: 'id' })], [nav.home()]],
  };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/search.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({
  // A menu label can depend on the language too.
  menu: replyMenu([[replyMenu.button((_, t) => t('menu.search'), search), replyMenu.close()]]),
  i18n: {
    messages,
    fallbackLocale: 'en',
    locales: { id: idTexts }, // easytg's own buttons (Back, Cancel, …) in Indonesian
  },
}).register(home, search, language);

bot.use(app);
bot.command('start', async (ctx) => {
  await app.session(ctx); // resolves the language (a choice made with setLocale is in the session)
  await app.showMenu(ctx, app.t(ctx)('search.prompt'));
  await app.open(ctx, home);
});
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
