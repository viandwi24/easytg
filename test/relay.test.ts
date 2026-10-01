import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, page, type EasyTGOptions } from '../src';
import { TelegramSimulator } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options });
  bot.use(app);
  const ann = sim.user.id;
  const bob = sim.addUser({ first_name: 'Bob' }).id;
  return { sim, bot, app, ann, bob };
}

const texts = (sim: TelegramSimulator, chat: number) => sim.messages(chat).map((m) => `${m.fromBot ? 'bot' : 'me'}: ${m.message.text ?? m.message.caption ?? Object.keys(m.message).slice(4).join()}`);

describe('app.relay', () => {
  test('copies messages both ways until it ends; commands and pages keep working', async () => {
    const { sim, bot, app, ann, bob } = setup();
    const home = page('home').render(() => ({ text: 'Home' }));
    app.command('start', home);
    bot.command('end', async (ctx) => {
      await app.relay.end(ctx, ctx.from!.id);
      await ctx.reply('Ended');
    });
    await sim.send('/start', { user: bob }); // Bob started the bot
    await sim.send('/start');
    await app.relay.start(bot, ann, bob, { data: { topic: 'tea' } });
    expect(await app.relay.peer(bot, bob)).toMatchObject({ peer: ann, data: { topic: 'tea' } });

    await sim.send('Hi Bob');
    await sim.sendLocation(1, 2, { user: bob });
    expect(texts(sim, bob).slice(-2)).toEqual(['me: location', 'bot: Hi Bob'].reverse());
    expect(sim.last(ann)!.message.location).toEqual({ latitude: 1, longitude: 2 });
    const copy = sim.messages(bob).find((m) => m.message.text === 'Hi Bob')!;
    expect(copy.message.from?.id).toBe(sim.botInfo.id); // a copy: Ann's account isn't shown

    await sim.send('/start'); // not relayed
    expect(sim.last(ann)!.message.text).toBe('Home');
    await sim.send('/end', { user: bob });
    expect(await app.relay.peer(bot, ann)).toBeUndefined();
    await sim.send('Anyone?');
    expect(sim.last(bob)!.message.text).toBe('Ended');
  });

  test('a dialogue takes the text first', async () => {
    const { sim, bot, app, ann, bob } = setup();
    const form = dialogue('form').steps([{ id: 'a', type: 'text', text: 'A?' }]).onFinish(({ answers }) => ({ text: `got ${answers.a}` }));
    app.command('form', form);
    await sim.send('/start', { user: bob });
    await sim.send('/form');
    await app.relay.start(bot, ann, bob);
    await sim.send('x');
    expect(sim.last(ann)!.message.text).toBe('got x');
    expect(texts(sim, bob)).toEqual(['me: /start']);
  });

  test('filter, events, and a peer who blocked the bot', async () => {
    const events: string[] = [];
    const { sim, bot, app, ann, bob } = setup({
      relay: { filter: ({ ctx }) => (ctx.message?.text?.includes('http') ? 'No links, please.' : true) },
    });
    app.on('relayMessage', ({ from, to }) => void events.push(`message ${from}→${to}`));
    app.on('relayEnd', async ({ users, reason, ctx }) => {
      events.push(`end ${users.join('/')} ${reason}`);
      if (ctx) await ctx.reply('They left.');
    });
    await sim.send('/start', { user: bob });
    await sim.send('/start');
    await app.relay.start(bot, ann, bob);
    await sim.send('see http://x.y');
    expect(sim.last(ann)!.message.text).toBe('No links, please.');
    await sim.send('hello');
    await sim.block(bob);
    await sim.send('still there?');
    expect(sim.last(ann)!.message.text).toBe('They left.');
    expect(events).toEqual([`message ${ann}→${bob}`, `end ${ann}/${bob} unreachable`]);
    expect(await app.relay.peer(bot, bob)).toBeUndefined();
  });

  test('starting a new relay ends the earlier one', async () => {
    const { sim, bot, app, ann, bob } = setup();
    const cid = sim.addUser({ first_name: 'Cid' }).id;
    const ends: string[] = [];
    app.on('relayEnd', ({ users }) => void ends.push(users.join('/')));
    await app.relay.start(bot, ann, bob);
    await app.relay.start(bot, ann, cid);
    expect(ends).toEqual([`${ann}/${bob}`]);
    expect(await app.relay.peer(bot, bob)).toBeUndefined();
    expect((await app.relay.peer(bot, cid))?.peer).toBe(ann);
    expect(() => app.relay.start(bot, ann, ann)).toThrow();
  });
});

test('replies point at the right message on the other side, and edits follow', async () => {
  const { sim, bot, app, ann, bob } = setup();
  await sim.send('/start', { user: bob });
  await sim.send('/start');
  await app.relay.start(bot, ann, bob);
  const question = await sim.send('Coffee or tea?');
  const copyForBob = sim.last(bob)!;
  expect(copyForBob.message.text).toBe('Coffee or tea?');

  // Bob replies to the copy he got; Ann sees a reply to her own message.
  await sim.send('Tea!', { user: bob, replyTo: copyForBob.message.message_id });
  expect(sim.last(ann)!.message.reply_to_message?.message_id).toBe(question.message.message_id);

  // Ann edits her question; Bob's copy changes too.
  await sim.editMessage(question.message.message_id, 'Coffee or tea, or water?');
  expect(sim.messages(bob).find((m) => m.message.message_id === copyForBob.message.message_id)!.message.text).toBe('Coffee or tea, or water?');
});
