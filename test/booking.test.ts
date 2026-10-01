import { afterAll, expect, test } from 'bun:test';
import { loadBot } from '../src/simulator/load';
import { isoDate } from '../src/steps';

const { sim, stop } = await loadBot(new URL('../examples/booking.ts', import.meta.url));
afterAll(stop);

test('examples/booking.ts: calendar, guests, extras, birthday note', async () => {
  await sim.send('/book');
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (tomorrow.getMonth() !== new Date().getMonth()) await sim.tap('›');
  await sim.tap(String(tomorrow.getDate()));
  expect(sim.last()!.message.text).toStartWith('🕐 What time on');
  await sim.tap('19:00');
  await sim.tap('➕');
  await sim.tap('➕');
  await sim.tap('✅ Done'); // 4 guests
  await sim.tap('🎂 Birthday');
  await sim.tap('🪟 Window seat');
  await sim.tap('✅ Done');
  await sim.send('Grandma');
  const text = sim.last()!.message.text!;
  expect(text).toContain('✅ Booked!');
  expect(text).toContain('at 19:00, 4 guests');
  expect(text).toContain('Extras: window, birthday');
  expect(text).toContain('Birthday: Grandma 🎂');
  await sim.tap('📋 My bookings');
  expect(sim.last()!.message.text).toContain('19:00, 4 guests');
  expect(isoDate(tomorrow)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
