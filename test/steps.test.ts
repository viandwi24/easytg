import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, type EasyTGOptions } from '../src';
import { calendar, parseIsoDate } from '../src/steps';
import { TelegramSimulator } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0 } });
  bot.use(app);
  return { sim, app };
}
const labels = (sim: TelegramSimulator) => sim.last()!.message.reply_markup!.inline_keyboard.map((row) => row.map((b) => b.text));

describe('multiChoice', () => {
  test('toggles in place, enforces min and max, answers in option order', async () => {
    const { sim, app } = setup();
    let got: unknown;
    const d = dialogue('toppings')
      .steps([
        {
          id: 'toppings',
          type: 'multiChoice',
          text: 'Toppings?',
          columns: 2,
          min: 1,
          max: 2,
          options: [
            { text: 'Cheese', value: 'cheese' },
            { text: 'Ham', value: 'ham' },
            { text: 'Olives', value: 'olives' },
          ],
        },
      ])
      .onFinish(({ answers }) => {
        const toppings: ('cheese' | 'ham' | 'olives')[] = answers.toppings; // typed from the options
        got = toppings;
        return { text: 'ok' };
      });
    app.command('start', d);
    await sim.send('/start');
    const prompt = sim.last()!.message.message_id;
    expect(labels(sim)).toEqual([['Cheese', 'Ham'], ['Olives'], ['✅ Done'], ['❌ Cancel']]);
    const alerts: string[] = [];
    sim.on('toast', (t) => void alerts.push(t.text));
    await sim.tap('✅ Done');
    expect(alerts).toEqual(['Please choose at least one option.']);
    await sim.tap('Olives');
    await sim.tap('Cheese');
    expect(sim.last()!.message.message_id).toBe(prompt); // edited, not sent again
    expect(labels(sim)[0]).toEqual(['✅ Cheese', 'Ham']);
    await sim.tap('Ham');
    expect(alerts.at(-1)).toBe('You can choose at most 2.');
    await sim.tap('✅ Olives'); // untoggle
    await sim.tap('Ham');
    await sim.tap('✅ Done');
    expect(got).toEqual(['cheese', 'ham']);
  });
});

describe('number', () => {
  test('➖ / ➕ within range, typed numbers, Done', async () => {
    const { sim, app } = setup();
    let got: unknown;
    const d = dialogue('guests')
      .steps([{ id: 'guests', type: 'number', text: 'How many guests?', min: 1, max: 12, bigStep: 5, format: (n) => `${n} 👤` }])
      .onFinish(({ answers }) => {
        const n: number = answers.guests;
        got = n;
        return { text: 'ok' };
      });
    app.command('start', d);
    await sim.send('/start');
    expect(labels(sim)[0]).toEqual([' ', ' ', '1 👤', '➕', '⏩']);
    await sim.tap('⏩');
    await sim.tap('➕');
    expect(labels(sim)[0]).toEqual(['⏪', '➖', '7 👤', '➕', '⏩']);
    await sim.tap('⏩');
    expect(labels(sim)[0]).toEqual(['⏪', '➖', '12 👤', ' ', ' ']);
    await sim.send('99');
    expect(sim.messages().some((m) => m.message.text === 'Please send a number from 1 to 12.')).toBe(true);
    await sim.send('4');
    expect(got).toBe(4);

    await sim.send('/start');
    await sim.tap('➕');
    await sim.tap('✅ Done');
    expect(got).toBe(2);
  });

  test('forged values out of range are refused', async () => {
    const { sim, app } = setup();
    const d = dialogue('n').steps([{ id: 'n', type: 'number', text: 'N?', min: 0, max: 3 }]).onFinish(() => ({ text: 'ok' }));
    app.command('start', d);
    await sim.send('/start');
    const plus = sim.last()!.message.reply_markup!.inline_keyboard[0]!.find((b) => b.text === '➕')!;
    const forged = { ...plus, callback_data: (plus as { callback_data: string }).callback_data.replace('v=1', 'v=50') };
    const alerts: string[] = [];
    sim.on('toast', (t) => void alerts.push(t.text));
    await sim.press(sim.last()!.message.message_id, forged);
    expect(alerts).toEqual(['This button is no longer active.']);
  });
});

describe('date', () => {
  test('a calendar in the user language, month paging, min and max, typed dates', async () => {
    const { sim, app } = setup();
    let got: unknown;
    const d = dialogue('when')
      .steps([{ id: 'day', type: 'date', text: 'Which day?', min: '2026-09-15', max: '2026-11-10', initial: '2026-09-20' }])
      .onFinish(({ answers }) => {
        const day: string = answers.day;
        got = day;
        return { text: 'ok' };
      });
    app.command('start', d);
    await sim.send('/start');
    let rows = labels(sim);
    expect(rows[0]).toEqual([' ', 'September 2026', '›']); // nothing before min's month
    expect(rows[1]).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(rows[2]).toEqual([' ', '·', '·', '·', '·', '·', '·']); // Sept 1 is a Tuesday; before min: disabled
    expect(rows[4]).toEqual(['·', '15', '16', '17', '18', '19', '20']);
    await sim.tap('›');
    await sim.tap('›');
    rows = labels(sim);
    expect(rows[0]).toEqual(['‹', 'November 2026', ' ']);
    await sim.send('2026-12-01'); // after max
    expect(sim.messages().some((m) => m.message.text === 'Please pick a date, or send one like 2026-12-31.')).toBe(true);
    await sim.tap('3');
    expect(got).toBe('2026-11-03');
  });

  test('Indonesian names, weeks from Sunday', () => {
    const cal = calendar('2026-02', { locale: 'id', weekStartsOn: 0 });
    expect(cal.title).toBe('Februari 2026');
    expect(cal.weekdays).toEqual(['M', 'S', 'S', 'R', 'K', 'J', 'S']);
    expect(cal.weeks[0]![0]!.day).toBe(1); // Feb 1, 2026 is a Sunday
    expect(parseIsoDate('2026-02-30')).toBeUndefined();
    expect(parseIsoDate(' 2026-02-28 ')).toBe('2026-02-28');
  });
});

test('`when` runs only once the dialogue gets to its step, so it can rely on earlier answers', async () => {
  const { sim, app } = setup();
  let got: unknown;
  const d = dialogue('w')
    .steps([
      { id: 'tags', type: 'multiChoice', text: 'Tags?', min: 0, options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }] },
      { id: 'why', type: 'text', text: 'Why A?', when: ({ answers }) => (answers.tags as string[]).includes('a') },
      { id: 'end', type: 'text', text: 'Last?' },
    ])
    .onFinish(({ answers }) => ((got = answers), { text: 'ok' }));
  app.command('start', d);
  await sim.send('/start');
  expect(sim.last()!.message.text).toBe('Tags?');
  await sim.tap('B');
  await sim.tap('✅ Done');
  expect(sim.last()!.message.text).toBe('Last?'); // "Why A?" skipped
  await sim.send('done');
  expect(got).toEqual({ tags: ['b'], end: 'done' });
});
