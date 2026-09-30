/**
 * Recorded in easytg preview (`bun src/cli.ts preview examples/match.ts --users 1`,
 * then "Export test"), unchanged except for the imports, which point at src/
 * in this repository. Keeps the preview → test path honest.
 */
import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

const sim = new TelegramSimulator({ user: {"is_bot":false,"id":1001,"first_name":"You","language_code":"en"} });
sim.addUser({"is_bot":false,"first_name":"Alice","id":1002});
const { stop } = await loadBot("./examples/match.ts", { simulator: sim });
afterAll(stop);

/** The last message of a chat: its text and inline buttons. */
function screen(chat = sim.user.id) {
  const m = sim.messages(chat).at(-1)?.message;
  const buttons = m?.reply_markup?.inline_keyboard?.flat().map((b) => b.text);
  return { text: m?.text ?? m?.caption ?? '', ...(buttons?.length ? { buttons } : {}) };
}

test('recorded conversation', async () => {
  await sim.send("/start");
  expect(screen()).toEqual({"text":"Let's make your profile. What's your name?","buttons":["❌ Cancel"]});
  await sim.send("Viandwi");
  expect(screen()).toEqual({"text":"How old are you?","buttons":["⬅️ Back","❌ Cancel"]});
  await sim.send("24");
  expect(screen()).toEqual({"text":"A few words about you (or \"-\" to skip):","buttons":["⬅️ Back","❌ Cancel"]});
  await sim.send("-");
  expect(screen()).toEqual({"text":"And a photo?","buttons":["📷 Send my own","🎲 A cartoon avatar","⬅️ Back","❌ Cancel"]});
  await sim.tap("🎲 A cartoon avatar");
  expect(screen()).toEqual({"text":"This is how others see you:\nViandwi, 24, 📍 2 km","buttons":["🏠 Home"]});
  await sim.send("/start");
  expect(screen()).toEqual({"text":"👋 Hi Viandwi! What now?","buttons":["🚀 Find people","👤 My profile","✏️ Edit"]});
  await sim.tap("🚀 Find people");
  expect(screen()).toEqual({"text":"Nadia, 22, 📍 1 km – coffee, films and long walks ☕️"});
  await sim.tap("❤️");
  expect(screen()).toEqual({"text":"Raka, 24, 📍 4 km – guitar at night, football on weekends ⚽️"});
  await sim.tap("👎");
  expect(screen()).toEqual({"text":"Salsa, 20, 📍 7 km – cat person 🐈 looking for a study buddy"});
});

test('two matches chat anonymously through the bot, until /end', async () => {
  const alice = 1002;
  const as = { user: alice };
  // You (from the recorded test) have a profile; Alice makes one and likes you.
  for (const answer of ['/start', 'Alice', '22', '-']) await sim.send(answer, as);
  await sim.tap('🎲 A cartoon avatar', as);
  await sim.send('/start', as);
  await sim.tap('🚀 Find people', as);
  expect(screen(alice).text).toStartWith('Viandwi, 24');
  await sim.tap('❤️', as);
  expect(sim.messages().some((m) => m.message.text === '💘 Someone liked your profile!')).toBe(true);
  await sim.tap('👀 Show');
  await sim.tap('❤️ Like back');
  expect(screen().text).toStartWith("🎉 It's a match with Alice!");
  await sim.tap('💬 Chat anonymously');
  expect(screen(alice).text).toBe('💬 Viandwi started a chat with you. Messages you send go to them. /end to stop.');

  await sim.send('hi Alice!');
  expect(screen(alice).text).toBe('hi Alice!');
  expect(sim.last(alice)!.message.from?.id).toBe(sim.botInfo.id); // through the bot: no account shown
  await sim.send('hey 👋', as);
  expect(screen().text).toBe('hey 👋');

  await sim.send('/end', as);
  expect(screen().text).toBe('👋 The chat has ended.');
  await sim.send('still there?');
  expect(screen(alice).text).not.toBe('still there?');
  expect(sim.commandsFor().map((c) => c.command)).toEqual(['start', 'profile', 'end']);
});
