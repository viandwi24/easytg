import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

const sim = new TelegramSimulator();
const ann = sim.user.id;
const bob = sim.addUser({ first_name: 'Bob' }).id;
const group = sim.createGroup({ title: 'Team', members: [ann, bob] }).id; // Ann created it: she is the owner
const { stop } = await loadBot(new URL('../examples/team.ts', import.meta.url), { simulator: sim });
afterAll(stop);
const seen = (as: number) => sim.messages(group, as).map((m) => m.message.text ?? '');
const ann_ = { chat: group, user: ann };
const bob_ = { chat: group, user: bob };

test('examples/team.ts: a shared board, personal pages and votes, ephemeral commands', async () => {
  await sim.send('/board', ann_);
  expect(seen(bob).at(-1)).toStartWith('📋 Team board');

  // Bob's settings: his alone; the admin tools are greyed out for him.
  await sim.tap('⚙️ My settings', bob_);
  expect(seen(bob).at(-1)).toStartWith('⚙️ Settings of Bob');
  expect(seen(ann).at(-1)).toStartWith('📋 Team board');
  const locked = sim.last(group, bob)!.message.reply_markup!.inline_keyboard[1]![0]!;
  expect(locked).toEqual({ text: '🛠 Admin tools 🔒', disabled: {} });
  await sim.tap('🔔 Notifications: on', bob_);
  expect(seen(bob).at(-1)).toStartWith('⚙️ Settings of Bob'); // edited in place, his copy
  expect(sim.last(group, bob)!.message.reply_markup!.inline_keyboard[0]![0]!.text).toBe('🔕 Notifications: off');

  // Ann is an admin: she can open them.
  await sim.tap('⚙️ My settings', ann_);
  await sim.tap('🛠 Admin tools', ann_);
  expect(seen(ann).at(-1)).toBe('🛠 Admin tools (only you see this).');

  // Votes are private, results public.
  await sim.tap('✖️ Close', bob_);
  await sim.tap('🗳 Vote for lunch', bob_);
  await sim.tap('🍣 Sushi', bob_);
  await sim.tap('🍜 Ramen', bob_);
  await sim.tap('✅ Done', bob_);
  expect(seen(bob).at(-1)).toBe('✅ You voted for 🍣 Sushi and 🍜 Ramen. Only you can see this.');
  expect(seen(ann).some((t) => t.includes('You voted'))).toBe(false);
  await sim.tap('⬅️ Back', ann_); // admin tools → her settings
  await sim.tap('✖️ Close', ann_); // the board shows again on her screen
  await sim.tap('📊 Lunch results', ann_);
  expect(seen(ann).at(-1)).toContain('🍣 Sushi: ▇ 1');
  // Ann opened the results on the shared board, so it changed for everyone (Bob's own vote note stays below it).
  expect(seen(bob).some((t) => t.includes('🍣 Sushi: ▇ 1'))).toBe(true);

  // Ephemeral commands: nobody else sees the command or the answer.
  await sim.send('/task buy coffee', bob_);
  expect(seen(bob).slice(-2)).toEqual(['/task buy coffee', '📝 Your tasks (only you can see this)\n• buy coffee']);
  expect(seen(ann).some((t) => t.includes('coffee'))).toBe(false);
});
