/**
 * Rich messages (Bot API 10.3): one message with headings, lists, tables,
 * quotes, collapsible sections, formulas, code and pictures, where a plain
 * message would need several.
 *
 *   BOT_TOKEN=123:abc bun run examples/rich.ts
 *
 * Send /start and browse the handbook.
 *
 * Shows: `rich` as Rich Markdown (strings and `md`, whose values are escaped
 * for it), as Rich HTML (`html`) with a button inside the text, and as
 * blocks; a keyboard under a rich page; text and rich pages editing into
 * each other in place.
 */
import { Bot } from 'grammy';
import { EasyTG, html, md, page } from '../src';

const plans = [
  { name: 'Starter', price: 0, seats: '1', support: 'Community' },
  { name: 'Team', price: 12, seats: 'up to 20', support: 'Email' },
  { name: 'Business | Plus', price: 49, seats: 'unlimited', support: '24/7 *priority*' }, // `|` and `*` are escaped by md``
];

const home = page('home').render(({ ctx, nav }) => ({
  rich: [
    '# 📘 Team handbook',
    '',
    md`Hi **${ctx.from?.first_name ?? 'there'}**! Everything you need, one message per topic.`,
    '',
    '- 💳 **Pricing**: plans side by side',
    '- ❓ **FAQ**: answers that open when you need them',
    '- 🚀 **Release notes**: built from blocks',
  ],
  keyboard: [
    [nav.button('💳 Pricing', pricing), nav.button('❓ FAQ', faq)],
    [nav.button('🚀 Release notes', notes), nav.button('📝 Plain text', plain)],
  ],
}));

// A table from data: md`` escapes each value, so a `|` in a name can't break the table.
const pricing = page('pricing').render(({ nav }) => ({
  rich: [
    '## 💳 Pricing',
    '',
    '| Plan | Price | Seats | Support |',
    '|:-----|------:|:-----:|:--------|',
    ...plans.map((p) => md`| **${p.name}** | ${p.price ? `$${p.price}/mo` : 'free'} | ${p.seats} | ${p.support} |`),
    '',
    'Paying yearly saves 20%[^yearly]:',
    '',
    '$$\\text{yearly} = 12 \\times \\text{monthly} \\times 0.8$$',
    '',
    '[^yearly]: Billed once a year, cancel any time.',
  ],
  keyboard: [[nav.back()]],
}));

// Rich HTML: collapsible answers, and a button inside the text (`nav.data` makes its callback data).
const faq = page('faq').render(({ nav }) => ({
  rich: html`<h2>❓ FAQ</h2>
<details open><summary>How do I invite my team?</summary><p>Open <b>Settings → Members</b> and share the invite link.</p></details>
<details><summary>Can I change plans later?</summary><p>Any time: the price changes from the next month on.</p></details>
<details><summary>Where is my data?</summary><p>In the EU, encrypted at rest.</p></details>
<blockquote>Questions we didn't answer? Write to us.<cite>The support team</cite></blockquote>
<p>Still deciding? <tg-button type="callback_data" style="primary" data="${nav.data(pricing)}">Compare plans</tg-button></p>`,
  keyboard: [[nav.back()]],
}));

// Blocks, as the Bot API defines them: for content you build from data.
const notes = page('notes').render(({ nav }) => ({
  rich: {
    blocks: [
      { type: 'heading', size: 2, text: '🚀 Release notes' },
      { type: 'photo', photo: { type: 'photo', media: 'https://picsum.photos/id/1018/800/450.jpg' }, caption: { text: 'The new dashboard' } },
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'Dashboard' }, ': a new home for your numbers'] }] },
          { blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'Exports' }, ': CSV and JSON'] }] },
          { has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'Dark mode' }] },
          { has_checkbox: true, blocks: [{ type: 'paragraph', text: 'Offline mode (next release)' }] },
        ],
      },
      { type: 'pre', language: 'bash', text: 'npm install our-cli@2' },
      { type: 'footer', text: 'Version 2.0 · October 2026' },
    ],
  },
  keyboard: [[nav.back()]],
}));

// A plain text page: pressing between it and the rich pages edits the same message.
const plain = page('plain').render(({ nav }) => ({
  text: ['📝 **A plain text page**', 'Pages can switch between text and rich in the same message.'],
  keyboard: [[nav.back()]],
}));

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/rich.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG().register(pricing, faq, notes, plain).command('start', home, { description: 'The handbook' });
bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start.`) });
