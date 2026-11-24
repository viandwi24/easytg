import { afterAll, expect, test } from 'bun:test';
import { messageText } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

const { sim, stop } = await loadBot(new URL('../examples/shop.ts', import.meta.url));
afterAll(stop);
const last = () => sim.last()!;
const shown = () => messageText(last().message) ?? '';
const photoOf = () => last().media?.url ?? '';
const callsSince = (from: number) => sim.calls.slice(from).map((c) => c.method);

test('examples/shop.ts: the catalog as cards, one photo per product, paged in place', async () => {
  await sim.send('/start');
  await sim.tap('🛍 Catalog');
  expect(shown()).toStartWith('Catalog\nPick a product:');
  await sim.tap('➡️'); // list page 2: T-shirts #5–8
  expect(last().message.reply_markup?.inline_keyboard[0]?.[0]?.text).toBe('T-shirt #5 · $14');

  // List → cards lands on the first product of that page, as a photo.
  await sim.tap('🃏 Card view');
  expect(last().media?.kind).toBe('photo');
  expect(photoOf()).toContain(encodeURIComponent('T-shirt #5'));
  expect(shown()).toBe('T-shirt #5\n$14\n\n5 of 12');
  const card = last().message.message_id;

  // ➡️ edits the same message: a new photo and caption (editMessageMedia).
  const before = sim.calls.length;
  await sim.tap('➡️');
  expect(last().message.message_id).toBe(card);
  expect(photoOf()).toContain(encodeURIComponent('T-shirt #6'));
  expect(shown()).toBe('T-shirt #6\n$15\n\n6 of 12');
  expect(callsSince(before)).toContain('editMessageMedia');
  expect(callsSince(before)).not.toContain('sendPhoto');

  await sim.tap('⏭️');
  expect(shown()).toBe('T-shirt #12\n$21\n\n12 of 12');
  await sim.tap('⬅️');
  expect(shown()).toBe('T-shirt #11\n$20\n\n11 of 12');
  expect(last().message.message_id).toBe(card);

  // Cards → list: the page with that product.
  await sim.tap('☰ List view');
  expect(shown()).toStartWith('Catalog\nPick a product:');
  expect(last().message.reply_markup?.inline_keyboard[0]?.[0]?.text).toBe('T-shirt #9 · $18');
});
