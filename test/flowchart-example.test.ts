import { afterAll, expect, test } from 'bun:test';
import { loadBot } from '../src/simulator/load';

const { sim, stop } = await loadBot(new URL('../examples/flowchart.ts', import.meta.url));
afterAll(stop);

test('examples/flowchart.ts: /flow shows the map of what was used', async () => {
  await sim.send('/start');
  await sim.tap('🛍 Catalog');
  await sim.tap('Green tea');
  await sim.tap('🛒 Order');
  await sim.tap('2');
  await sim.send('/flow');
  const text = sim.last()!.message.text!;
  expect(text).toStartWith('🗺 This bot, so far\nflowchart LR');
  expect(text).toContain('-->|"🛍 Catalog"|');
  expect(text).toContain('-->|"Green tea · Black tea"|'); // both catalog buttons lead to the product page
  expect(text).toContain('-.->|redirect|'); // order → thanks
  const entities = sim.last()!.message.entities!;
  expect(entities.some((e) => e.type === 'pre')).toBe(true);
  const link = sim.last()!.message.reply_markup!.inline_keyboard[0]![0] as { url: string };
  expect(link.url).toStartWith('https://mermaid.live/edit#base64:');
});
