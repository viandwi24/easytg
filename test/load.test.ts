import { afterAll, expect, test } from 'bun:test';
import { loadBot } from '../src/simulator/load';

// The example file runs as it is, `await bot.start()` included.
const { sim, bots, stop } = await loadBot(new URL('../examples/getting-started.ts', import.meta.url));
afterAll(stop);

test('an unchanged bot file runs against the simulator', async () => {
  expect(bots).toHaveLength(1);
  await sim.send('/start');
  expect(sim.messages().map((m) => m.message.text)).toEqual(['/start', 'Welcome! Use the menu below.', 'Welcome, **You**! What would you like?'.replace(/\*\*/g, '')]);
  await sim.tap('🛍 Products');
  expect(sim.last()!.message.text).toContain('Products');
  await sim.tap('Coffee · $4');
  await sim.tap('🛒 Order');
  await sim.tap('2');
  await sim.send('no sugar');
  expect(sim.last()!.message.text).toBe('✅ Order placed!');
  await sim.tap('🧾 My orders');
  expect(sim.last()!.message.text).toContain('2 × coffee');
});
