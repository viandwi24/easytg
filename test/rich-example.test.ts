import { afterAll, expect, test } from 'bun:test';
import { messageText } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

const { sim, stop } = await loadBot(new URL('../examples/rich.ts', import.meta.url));
afterAll(stop);
const shown = () => messageText(sim.last()!.message) ?? '';

test('examples/rich.ts: Rich Markdown, Rich HTML and blocks pages, in one message', async () => {
  await sim.send('/start');
  const id = sim.last()!.message.message_id;
  expect(shown()).toStartWith('📘 Team handbook\nHi You! Everything you need');

  await sim.tap('💳 Pricing');
  const table = sim.last()!.message.rich_message!.blocks.find((b) => b.type === 'table')!;
  expect(table.type === 'table' && table.cells.map((row) => row.map((c) => messageText({ rich_message: { blocks: [{ type: 'paragraph', text: c.text ?? '' }] } } as never)))).toEqual([
    ['Plan', 'Price', 'Seats', 'Support'],
    ['Starter', 'free', '1', 'Community'],
    ['Team', '$12/mo', 'up to 20', 'Email'],
    ['Business | Plus', '$49/mo', 'unlimited', '24/7 *priority*'], // escaped by md``: not a column, not italic
  ]);
  expect(sim.last()!.message.message_id).toBe(id); // rich pages edit in place

  await sim.tap('⬅️ Back');
  await sim.tap('❓ FAQ');
  expect(shown()).toContain('How do I invite my team?');
  await sim.tap('Compare plans'); // a button inside the text
  expect(shown()).toStartWith('💳 Pricing');
  await sim.tap('⬅️ Back');
  expect(shown()).toStartWith('❓ FAQ');

  // (Back twice in a row would be a double tap: a new menu instead.)
  await sim.send('/start');
  const menu = sim.last()!.message.message_id;
  await sim.tap('🚀 Release notes');
  expect(shown()).toBe('🚀 Release notes\nThe new dashboard\n• Dashboard: a new home for your numbers\n• Exports: CSV and JSON\n☑ Dark mode\n☐ Offline mode (next release)\nnpm install our-cli@2\nVersion 2.0 · October 2026');
  expect(sim.last()!.message.rich_message!.blocks[1]).toMatchObject({ type: 'photo', caption: { text: 'The new dashboard' } });

  await sim.tap('⬅️ Back');
  await sim.tap('📝 Plain text');
  expect(sim.last()!.message).toMatchObject({ message_id: menu, text: '📝 A plain text page\nPages can switch between text and rich in the same message.' });
});
