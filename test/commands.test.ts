import { describe, expect, test } from 'bun:test';
import { EasyTG, EasyTGError, dialogue, page, type EasyTGOptions } from '../src';
import { TelegramSimulator } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options });
  bot.use(app);
  return { sim, bot, app };
}

describe('app.command', () => {
  test('opens pages and starts dialogues, with params from the arguments', async () => {
    const { sim, app, bot } = setup();
    const home = page('home').render(() => ({ text: 'Home' }));
    const search = page<{ q?: string }>('search').render(({ params }) => ({ text: `Results for ${params.q ?? 'nothing'}` }));
    const feedback = dialogue('feedback')
      .steps([{ id: 'text', type: 'text', text: 'Your feedback?' }])
      .onFinish(({ answers }) => ({ text: `Thanks: ${answers.text}` }));
    app.command('start', home).command(['find', 'search'], search, { params: (q) => (q ? { q } : {}) }).command('feedback', feedback);
    const passed: string[] = [];
    bot.on('message:text', (ctx) => void passed.push(ctx.message.text));

    await sim.send('/start');
    expect(sim.last()!.message.text).toBe('Home');
    await sim.send('/find green tea');
    expect(sim.last()!.message.text).toBe('Results for green tea');
    await sim.send('/search@demo_bot');
    expect(sim.last()!.message.text).toBe('Results for nothing');
    await sim.send('/feedback');
    await sim.send('Great');
    expect(sim.last()!.message.text).toBe('Thanks: Great');
    await sim.send('/unknown');
    await sim.send('/start@other_bot');
    expect(passed).toEqual(['/unknown', '/start@other_bot']);
  });

  test('a command leaves a dialogue and page text input', async () => {
    const { sim, app } = setup();
    const home = page('home').render(() => ({ text: 'Home' }));
    const form = dialogue('form')
      .steps([{ id: 'a', type: 'text', text: 'A?' }])
      .onFinish(() => ({ text: 'done' }));
    app.command('start', home).command('form', form);
    await sim.send('/form');
    await sim.send('/start');
    expect(sim.last()!.message.text).toBe('Home');
    await sim.send('hello'); // no dialogue anymore
    expect(sim.last()!.message.text).toBe('hello');
  });

  test('chats: private-only and group-only commands', async () => {
    const { sim, app, bot } = setup();
    const settings = page('settings').render(() => ({ text: 'Settings' }));
    app.command('settings', settings, { chats: 'private' });
    const passed: string[] = [];
    bot.on('message:text', (ctx) => void passed.push(ctx.chat.type));
    const group = sim.createGroup({ title: 'G' });
    await sim.send('/settings', { chat: group.id });
    expect(passed).toEqual(['supergroup']);
    await sim.send('/settings');
    expect(sim.last()!.message.text).toBe('Settings');
  });

  test('invalid or duplicate names throw', () => {
    const { app } = setup();
    const p = page('p').render(() => ({ text: 'p' }));
    expect(() => app.command('Start', p)).toThrow(EasyTGError);
    expect(() => app.command('a'.repeat(33), p)).toThrow(EasyTGError);
    app.command('/go', p);
    expect(() => app.command('go', p)).toThrow('already defined');
    expect(() => app.command('x', page('p').render(() => ({ text: 'other' })))).toThrow('Another page');
  });
});

describe('app.syncCommands', () => {
  test('sets the default, private and group lists, translated', async () => {
    const { sim, app, bot } = setup({ i18n: { messages: { en: { cmd: { help: 'Help' } }, id: { cmd: { help: 'Bantuan' } } } } });
    const p = (id: string) => page(id).render(() => ({ text: id }));
    app
      .command('start', p('home'), { description: 'Main menu' })
      .command('help', p('help'), { description: (_locale, t) => t('cmd.help') })
      .command('settings', p('settings'), { description: 'Settings', chats: 'private' })
      .command('hidden', p('hidden'));
    await app.syncCommands(bot);

    const names = (list: { command: string }[]) => list.map((c) => c.command);
    expect(names(sim.commands)).toEqual(['start', 'help']);
    expect(names(sim.commandsFor())).toEqual(['start', 'help', 'settings']);
    const group = sim.createGroup({ title: 'G' });
    expect(names(sim.commandsFor(group.id))).toEqual(['start', 'help']);
    const indonesian = sim.addUser({ first_name: 'Budi', language_code: 'id' });
    expect(sim.commandsFor(indonesian.id, indonesian.id).map((c) => c.description)).toEqual(['Main menu', 'Bantuan', 'Settings']);
    // Nothing is only for groups: that list is deleted, not set.
    expect(sim.calls.filter((c) => c.method === 'deleteMyCommands').map((c) => c.payload.scope.type)).toEqual(['all_group_chats', 'all_group_chats', 'all_group_chats']);
  });
});
