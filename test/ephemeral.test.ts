import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, dialogue, page, type EasyTGOptions } from '../src';
import { TelegramSimulator } from '../src/simulator';

function setup(options: EasyTGOptions = {}, botAdmin = true) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ownerOnly: false } });
  bot.use(app);
  const ann = sim.user.id;
  const bob = sim.addUser({ first_name: 'Bob' }).id;
  const group = sim.createGroup({ title: 'Team', members: [ann, bob], botAdmin });
  return { sim, bot, app, ann, bob, group: group.id };
}

const texts = (sim: TelegramSimulator, chat: number, as: number) => sim.messages(chat, as).map((m) => m.message.text ?? m.message.caption ?? '');

afterEach(() => setSystemTime());

describe('ephemeral pages in groups', () => {
  test('a shared menu opens a page for the presser only; their own copy navigates, goes back and closes', async () => {
    const { sim, app, ann, bob, group } = setup();
    const settings = page('settings').render(({ ctx, nav }) => ({
      text: `Settings of ${ctx.from?.first_name}`,
      keyboard: [[nav.button('🔔 Notifications', notifications)], [nav.back(), nav.close()]],
    }));
    const notifications = page('notifications').render(({ nav }) => ({ text: 'Notifications: on', keyboard: [[nav.back()]] }));
    const menu = page('menu').render(({ nav }) => ({ text: 'Team menu', keyboard: [[nav.button('⚙️ My settings', settings, {}, { mode: 'ephemeral' })]] }));
    app.register(settings, notifications).command('menu', menu);
    await sim.send('/menu', { chat: group });

    await sim.tap('⚙️ My settings', { chat: group, user: ann });
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Settings of You']); // the menu is replaced on Ann's screen
    expect(texts(sim, group, bob)).toEqual(['/menu', 'Team menu']); // Bob sees nothing new
    expect(sim.last(group, ann)!.message.ephemeral_message_id).toBeDefined();
    expect(sim.calls.find((c) => c.method === 'sendMessage' && c.payload.ephemeral_message_parameters)?.payload.ephemeral_message_parameters).toMatchObject({
      receiver_user_id: ann,
      replace_callback_query_message: true,
    });

    // Bob can use the shared menu at the same time: his own copy.
    await sim.tap('⚙️ My settings', { chat: group, user: bob });
    expect(texts(sim, group, bob)).toEqual(['/menu', 'Settings of Bob']);
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Settings of You']);

    // Buttons of an ephemeral message edit it in place.
    await sim.tap('🔔 Notifications', { chat: group, user: ann });
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Notifications: on']);
    expect(sim.calls.some((c) => c.method === 'editEphemeralMessageText')).toBe(true);
    expect(sim.calls.some((c) => c.method === 'editMessageText')).toBe(false); // the shared menu was never edited
    await sim.tap('⬅️ Back', { chat: group, user: ann });
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Settings of You']);
    await sim.tap('⬅️ Back', { chat: group, user: ann }); // back to the menu page, still Ann's own copy
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Team menu']);
    expect(sim.last(group, ann)!.receiver).toBe(ann);

    // Close: the ephemeral copy goes away and the shared menu shows again.
    await sim.tap('⚙️ My settings', { chat: group, user: ann });
    await sim.tap('❌ Close', { chat: group, user: ann });
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Team menu']);
    expect(texts(sim, group, bob)).toEqual(['/menu', 'Settings of Bob']);
  });

  test('ephemeral commands, answered ephemerally, even by a bot that is not an admin', async () => {
    const { sim, bot, app, ann, bob, group } = setup({}, false);
    const mine = page('mine').render(({ ctx }) => ({ text: `Your tasks, ${ctx.from?.first_name}: none` }));
    app.command('mytasks', mine, { description: 'My tasks', ephemeral: true });
    await app.syncCommands(bot);
    expect(sim.commandsFor(group, ann)).toEqual([{ command: 'mytasks', description: 'My tasks', is_ephemeral: true }] as never);

    await sim.send('/mytasks', { chat: group, user: bob }); // sent ephemerally, as the command is declared
    expect(texts(sim, group, bob)).toEqual(['/mytasks', 'Your tasks, Bob: none']);
    expect(texts(sim, group, ann)).toEqual([]);
    const answer = sim.calls.find((c) => c.method === 'sendMessage')!.payload;
    expect(answer.reply_parameters).toEqual({ ephemeral_message_id: 1 }); // the reply is what allows a non-admin bot
  });

  test('a bot that is not an admin gets 15 seconds after a press', async () => {
    const { sim, bot, app, ann, group } = setup({}, false);
    let queryId = '';
    bot.callbackQuery('later', (ctx) => void (queryId = ctx.callbackQuery.id));
    app.command('menu', page('m').render(() => ({ text: 'Menu', keyboard: [[{ text: 'Later', callback_data: 'later' }]] })));
    await sim.send('/menu', { chat: group });
    await sim.tap('Later', { chat: group, user: ann });
    const send = () => bot.api.sendMessage(group, 'hi', { ephemeral_message_parameters: { receiver_user_id: ann, callback_query_id: queryId } });
    await expect(send()).resolves.toBeDefined();
    setSystemTime(new Date(Date.now() + 16_000));
    await expect(send()).rejects.toThrow('within 15 seconds');
    await expect(bot.api.sendMessage(group, 'hi', { ephemeral_message_parameters: { receiver_user_id: ann } })).rejects.toThrow('Forbidden');
  });

  test('private chats: ephemeral means a normal edit', async () => {
    const { sim, app } = setup();
    const b = page('b').render(() => ({ text: 'B' }));
    app.register(b).command('start', page('a').render(({ nav }) => ({ text: 'A', keyboard: [[nav.button('Go', b, {}, { mode: 'ephemeral' })]] })));
    await sim.send('/start');
    const id = sim.last()!.message.message_id;
    await sim.tap('Go');
    expect(sim.last()!.message).toMatchObject({ message_id: id, text: 'B' });
    expect(sim.calls.some((c) => c.payload.ephemeral_message_parameters)).toBe(false);
  });

  test('albums can not be ephemeral: a clear error, and the shared menu is left alone', async () => {
    const { sim, app, ann, group } = setup();
    const errors: string[] = [];
    app.on('error', ({ error }) => void errors.push((error as Error).message));
    const gallery = page('gallery').render(() => ({ album: [{ type: 'photo', media: 'https://e.com/1.jpg' }, { type: 'photo', media: 'https://e.com/2.jpg' }] }));
    app.register(gallery).command('menu', page('m').render(({ nav }) => ({ text: 'Menu', keyboard: [[nav.button('Photos', gallery, {}, { mode: 'ephemeral' })]] })));
    await sim.send('/menu', { chat: group });
    await sim.tap('Photos', { chat: group, user: ann });
    expect(errors).toEqual(["Albums can't be sent as ephemeral messages"]);
    expect(texts(sim, group, ann)).toEqual(['/menu', 'Menu']);
  });

  test('a dialogue started ephemerally asks the presser only, and keeps the shared menu', async () => {
    const { sim, app, ann, bob, group } = setup();
    let got: unknown;
    const poll = dialogue('vote')
      .steps([{ id: 'pick', type: 'choice', text: 'Your vote?', options: [{ text: 'Pizza', value: 'pizza' }, { text: 'Sushi', value: 'sushi' }] }])
      .onFinish(({ answers }) => ((got = answers.pick), { text: 'Thanks for voting' }));
    app.register(poll).command('lunch', page('m').render(({ nav }) => ({ text: 'Lunch?', keyboard: [[nav.button('🗳 Vote', poll, {}, { mode: 'ephemeral' })]] })));
    await sim.send('/lunch', { chat: group });
    await sim.tap('🗳 Vote', { chat: group, user: ann });
    expect(texts(sim, group, ann)).toEqual(['/lunch', 'Your vote?']);
    expect(texts(sim, group, bob)).toEqual(['/lunch', 'Lunch?']);
    await sim.tap('Sushi', { chat: group, user: ann });
    expect(got).toBe('sushi');
    expect(texts(sim, group, bob)).toEqual(['/lunch', 'Lunch?']); // still there for everyone else
    expect(sim.messages(group, ann).at(-1)!.message.text).toBe('Thanks for voting');
    expect(sim.messages(group, ann).at(-1)!.receiver).toBe(ann);
    // The question went away like any dialogue prompt (deleteEphemeralMessage), so the shared menu is back for Ann.
    expect(texts(sim, group, ann)).toEqual(['/lunch', 'Lunch?', 'Thanks for voting']);
    expect(sim.calls.some((c) => c.method === 'deleteEphemeralMessage')).toBe(true);
  });
});
