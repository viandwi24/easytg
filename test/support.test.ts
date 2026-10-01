import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

// You (1001) are the agent; Alice is a customer.
process.env.AGENT_IDS = '1001';
const sim = new TelegramSimulator();
const alice = sim.addUser({ first_name: 'Alice' }).id;
const { stop } = await loadBot(new URL('../examples/support.ts', import.meta.url), { simulator: sim });
afterAll(stop);
const agent = sim.user.id;
const as = { user: alice };
const text = (chat = agent) => sim.last(chat)!.message.text;

test('examples/support.ts: ticket, agent takes it, relayed chat, links filtered, close and rating', async () => {
  await sim.send('/start');
  expect(text()).toContain('Agent desk');
  await sim.send('/start', as);
  await sim.tap('💬 Talk to support', as);
  await sim.send('My order never arrived', as);
  expect(text(alice)).toBe('🎫 Ticket #1 is in the queue. An agent will be with you shortly.');
  expect(text()).toContain('Ticket #1 from Alice');

  await sim.tap('✋ Take #1');
  expect(text()).toContain("You're on ticket #1 with Alice.");
  expect(text(alice)).toContain('An agent joined');

  await sim.send('Hi Alice, let me check.');
  expect(text(alice)).toBe('Hi Alice, let me check.');
  await sim.send('see https://example.com', as);
  expect(text(alice)).toBe('🔗 Links are not allowed here, sorry.');
  await sim.send('Thanks!', as);
  expect(text()).toBe('Thanks!');

  await sim.send('/close', as);
  expect(text(alice)).toBe('✅ Chat closed. How did we do?');
  expect(text()).toBe('The customer closed ticket #1.');
  await sim.tap('5⭐', as);
  expect(text(alice)).toBe('Thanks for your feedback! 🙏');
  await sim.send('hello?', as);
  expect(text()).not.toBe('hello?'); // no longer relayed
});
