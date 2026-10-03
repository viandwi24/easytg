import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, EasyTGError, dialogue, type EasyTGOptions } from '../src';
import { TelegramSimulator } from '../src/simulator';
import { addMonths, calendar, dayInZone, parseIsoDate, resolveDate, startMonth, validMonth } from '../src/steps';

const at = (iso: string) => new Date(iso);

describe('dayInZone: a moment is a different day in different places', () => {
  test('the same moment around the world', () => {
    const moment = at('2026-09-30T18:30:00Z');
    expect(dayInZone(moment, 'UTC')).toBe('2026-09-30');
    expect(dayInZone(moment, 'Asia/Jakarta')).toBe('2026-10-01'); // UTC+7: 01:30
    expect(dayInZone(moment, 'Asia/Kathmandu')).toBe('2026-10-01'); // UTC+5:45: 00:15
    expect(dayInZone(moment, 'Asia/Kolkata')).toBe('2026-10-01'); // UTC+5:30: 00:00
    expect(dayInZone(moment, 'Asia/Dubai')).toBe('2026-09-30'); // UTC+4: 22:30
    expect(dayInZone(moment, 'America/New_York')).toBe('2026-09-30');
    expect(dayInZone(moment, 'Pacific/Kiritimati')).toBe('2026-10-01'); // UTC+14
    expect(dayInZone(moment, 'Pacific/Pago_Pago')).toBe('2026-09-30'); // UTC-11
  });

  test('a minute before and at midnight', () => {
    expect(dayInZone(at('2026-09-30T16:59:59Z'), 'Asia/Jakarta')).toBe('2026-09-30');
    expect(dayInZone(at('2026-09-30T17:00:00Z'), 'Asia/Jakarta')).toBe('2026-10-01');
  });

  test('new year', () => {
    expect(dayInZone(at('2026-12-31T15:00:00Z'), 'Asia/Tokyo')).toBe('2027-01-01');
    expect(dayInZone(at('2026-12-31T14:59:59Z'), 'Asia/Tokyo')).toBe('2026-12-31');
    expect(dayInZone(at('2027-01-01T04:59:59Z'), 'America/New_York')).toBe('2026-12-31');
  });

  test('days around daylight saving changes keep their midnights', () => {
    // New York: clocks go forward on 2026-03-08 (EST, UTC-5 → EDT, UTC-4).
    expect(dayInZone(at('2026-03-08T04:59:59Z'), 'America/New_York')).toBe('2026-03-07');
    expect(dayInZone(at('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(dayInZone(at('2026-03-09T03:59:59Z'), 'America/New_York')).toBe('2026-03-08'); // 23:59 EDT
    expect(dayInZone(at('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
    // ...and back on 2026-11-01 (EDT → EST).
    expect(dayInZone(at('2026-11-01T03:59:59Z'), 'America/New_York')).toBe('2026-10-31');
    expect(dayInZone(at('2026-11-02T04:59:59Z'), 'America/New_York')).toBe('2026-11-01'); // 23:59 EST
    // Berlin: 2026-03-29 (CET → CEST).
    expect(dayInZone(at('2026-03-28T22:59:59Z'), 'Europe/Berlin')).toBe('2026-03-28');
    expect(dayInZone(at('2026-03-28T23:00:00Z'), 'Europe/Berlin')).toBe('2026-03-29');
    expect(dayInZone(at('2026-03-29T21:59:59Z'), 'Europe/Berlin')).toBe('2026-03-29');
  });

  test('an invalid date or zone is an error, not a wrong day', () => {
    expect(() => dayInZone(new Date('nope'))).toThrow('Invalid Date');
    expect(() => dayInZone(new Date(), 'Mars/Olympus_Mons')).toThrow();
  });
});

describe('days', () => {
  test('parseIsoDate accepts real days only', () => {
    expect(parseIsoDate('2028-02-29')).toBe('2028-02-29'); // leap year
    expect(parseIsoDate('2000-02-29')).toBe('2000-02-29'); // divisible by 400
    expect(parseIsoDate('2026-02-29')).toBeUndefined();
    expect(parseIsoDate('2100-02-29')).toBeUndefined(); // divisible by 100, not 400
    expect(parseIsoDate('2026-04-31')).toBeUndefined();
    expect(parseIsoDate('2026-13-01')).toBeUndefined();
    expect(parseIsoDate('2026-00-10')).toBeUndefined();
    expect(parseIsoDate('2026-01-00')).toBeUndefined();
    expect(parseIsoDate('2026-1-01')).toBeUndefined();
    expect(parseIsoDate('0000-01-01')).toBeUndefined();
    expect(parseIsoDate('0099-12-31')).toBe('0099-12-31'); // not 1999
    expect(parseIsoDate('  2026-12-31\n')).toBe('2026-12-31');
    expect(parseIsoDate('31/12/2026')).toBeUndefined();
  });

  test('addMonths across years, both ways', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-05', 24)).toBe('2028-05');
  });

  test('resolveDate: strings as they are, Dates in the zone, mistakes refused', () => {
    expect(resolveDate('2026-10-01', 'Pacific/Pago_Pago', 'min')).toBe('2026-10-01'); // a day has no zone
    expect(resolveDate(at('2026-09-30T18:30:00Z'), 'Asia/Jakarta', 'min')).toBe('2026-10-01');
    expect(resolveDate(() => at('2026-09-30T18:30:00Z'), 'UTC', 'min')).toBe('2026-09-30');
    expect(resolveDate(undefined, 'UTC', 'min')).toBeUndefined();
    expect(() => resolveDate('2026-13-01', 'UTC', 'Step "day": min')).toThrow('Step "day": min must be a Date or a "YYYY-MM-DD" day, got "2026-13-01"');
    expect(() => resolveDate('01/10/2026', 'UTC', 'max')).toThrow(EasyTGError);
    expect(() => resolveDate(new Date('x'), 'UTC', 'max')).toThrow('max is an Invalid Date');
  });

  test('startMonth uses today in the zone, kept within min and max', () => {
    setSystemTime(at('2026-09-30T18:30:00Z'));
    expect(startMonth(undefined, undefined, undefined, 'UTC')).toBe('2026-09');
    expect(startMonth(undefined, undefined, undefined, 'Asia/Jakarta')).toBe('2026-10');
    expect(startMonth(undefined, '2026-11-15', undefined, 'UTC')).toBe('2026-11');
    expect(startMonth('2027-03-01', undefined, '2026-12-31', 'UTC')).toBe('2026-12');
    expect(validMonth('2026-13', undefined, undefined)).toBe(false);
    expect(validMonth('0000-01', undefined, undefined)).toBe(false);
    expect(validMonth('2026-10', '2026-10-31', '2026-11-01')).toBe(true);
    expect(validMonth('2026-09', '2026-10-31', undefined)).toBe(false);
  });
});

describe('calendar', () => {
  test('known months, Monday or Sunday first', () => {
    const october = calendar('2026-10', {}); // 2026-10-01 is a Thursday
    expect(october.title).toBe('October 2026');
    expect(october.weeks[0]!.map((d) => d?.day ?? null)).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(october.weeks.at(-1)!.map((d) => d?.day ?? null)).toEqual([26, 27, 28, 29, 30, 31, null]);
    const sundayFirst = calendar('2026-10', { weekStartsOn: 0 });
    expect(sundayFirst.weeks[0]!.map((d) => d?.day ?? null)).toEqual([null, null, null, null, 1, 2, 3]);
    expect(calendar('2028-02', {}).weeks.flat().filter(Boolean)).toHaveLength(29);
    expect(calendar('2026-02', {}).weeks.flat().filter(Boolean)).toHaveLength(28);
    expect(calendar('0099-12', {}).weeks.flat().filter(Boolean).at(-1)!.iso).toBe('0099-12-31');
  });

  test('the same in every server time zone', () => {
    const original = process.env.TZ;
    const months = ['2026-03', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2028-02'];
    const render = () => JSON.stringify(months.map((m) => calendar(m, { min: '2026-09-15', max: '2027-01-10', locale: 'id' })));
    try {
      process.env.TZ = 'UTC';
      const reference = render();
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Santiago', 'Asia/Kathmandu', 'America/New_York', 'Australia/Lord_Howe']) {
        process.env.TZ = zone;
        expect(render()).toBe(reference);
      }
    } finally {
      process.env.TZ = original;
    }
  });

  test('min and max: days out of range, and paging limits', () => {
    const cal = calendar('2026-10', { min: '2026-10-05', max: '2026-10-28' });
    const days = cal.weeks.flat().filter((d) => d !== null);
    expect(days.filter((d) => d.enabled).map((d) => d.day)).toEqual(Array.from({ length: 24 }, (_, i) => i + 5));
    expect(cal.previous).toBeUndefined();
    expect(cal.next).toBeUndefined();
    expect(calendar('2026-12', { min: '2026-10-05' })).toMatchObject({ previous: '2026-11', next: '2027-01' });
  });
});

describe('date steps', () => {
  afterEach(() => setSystemTime());

  function setup(options: EasyTGOptions = {}) {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0 } });
    bot.use(app);
    return { sim, app };
  }
  const enabled = (sim: TelegramSimulator) =>
    sim
      .last()!
      .message.reply_markup!.inline_keyboard.slice(2, -1)
      .flat()
      .filter((b) => !('disabled' in b))
      .map((b) => b.text)
      .filter((t) => /^\d+$/.test(t));

  test('"from today" is today in the step time zone', async () => {
    // 11:00 UTC on Sept 30: already Oct 1 at UTC+14, still Sept 30 at UTC-11.
    setSystemTime(at('2026-09-30T11:00:00Z'));
    for (const [zone, title, first] of [
      ['Pacific/Kiritimati', 'October 2026', '1'],
      ['Pacific/Pago_Pago', 'September 2026', '30'],
    ] as const) {
      const { sim, app } = setup({ dialogues: { timeZone: zone } });
      let got: unknown;
      app.command('start', dialogue('d').steps([{ id: 'day', type: 'date', text: 'Day?', min: () => new Date() }]).onFinish(({ answers }) => ((got = answers.day), { text: 'ok' })));
      await sim.send('/start');
      const header = sim.last()!.message.reply_markup!.inline_keyboard[0]!.map((b) => b.text);
      expect(header[1]).toBe(title);
      expect(header[0]).toBe(' '); // nothing before today
      expect(enabled(sim)[0]).toBe(first);
      await sim.tap(first);
      expect(got).toBe(zone === 'Pacific/Kiritimati' ? '2026-10-01' : '2026-09-30');
    }
  });

  test('a per-user time zone from the session, over the app default', async () => {
    setSystemTime(at('2026-09-30T18:30:00Z'));
    const { sim, app } = setup({ dialogues: { timeZone: 'UTC' } });
    app.command(
      'start',
      dialogue('d')
        .steps([{ id: 'day', type: 'date', text: 'Day?', min: () => new Date(), timeZone: ({ session }) => session.get<string>('tz') }])
        .onFinish(() => ({ text: 'ok' })),
    );
    app.command(
      'jakarta',
      dialogue('tz').steps([]).onFinish(({ session }) => (session.set('tz', 'Asia/Jakarta'), { text: 'Time zone set' })),
    );
    await sim.send('/start');
    expect(sim.last()!.message.reply_markup!.inline_keyboard[0]![1]!.text).toBe('September 2026'); // UTC
    await sim.send('/jakarta');
    await sim.send('/start');
    expect(sim.last()!.message.reply_markup!.inline_keyboard[0]![1]!.text).toBe('October 2026'); // already Oct 1 in Jakarta
  });

  test('typed dates and forged buttons outside the range are refused', async () => {
    setSystemTime(at('2026-09-30T05:00:00Z'));
    const { sim, app } = setup({ dialogues: { timeZone: 'UTC' } });
    let got: unknown;
    app.command('start', dialogue('d').steps([{ id: 'day', type: 'date', text: 'Day?', min: () => new Date(), max: '2026-10-31' }]).onFinish(({ answers }) => ((got = answers.day), { text: 'ok' })));
    await sim.send('/start');
    const button = sim.last()!.message.reply_markup!.inline_keyboard.flat().find((b) => b.text === '30') as { text: string; callback_data: string };
    const alerts: string[] = [];
    sim.on('toast', (t) => void alerts.push(t.text));
    await sim.press(sim.last()!.message.message_id, { ...button, callback_data: button.callback_data.replace('2026-09-30', '2026-09-29') }); // yesterday
    expect(alerts).toEqual(['This button is no longer active.']);
    await sim.send('2026-11-01'); // after max
    await sim.send('2026-02-30'); // not a day
    expect(got).toBeUndefined();
    await sim.send('2026-10-31');
    expect(got).toBe('2026-10-31');
  });

  test('mistakes in the setup are clear errors', async () => {
    expect(() => new EasyTG({ dialogues: { timeZone: 'Asia/Jakart' } })).toThrow('Unknown time zone "Asia/Jakart"');
    const { sim, app } = setup();
    const errors: string[] = [];
    app.on('error', ({ error }) => void errors.push((error as Error).message));
    app.command('a', dialogue('a').steps([{ id: 'day', type: 'date', text: 'Day?', min: '2026-12-01', max: '2026-11-01' }]).onFinish(() => ({ text: 'ok' })));
    app.command('b', dialogue('b').steps([{ id: 'day', type: 'date', text: 'Day?', min: '2026-13-01' }]).onFinish(() => ({ text: 'ok' })));
    app.command('c', dialogue('c').steps([{ id: 'day', type: 'date', text: 'Day?', timeZone: 'Nowhere/Land' }]).onFinish(() => ({ text: 'ok' })));
    await sim.send('/a');
    await sim.send('/b');
    await sim.send('/c');
    expect(errors).toEqual([
      'Step "day": min (2026-12-01) is after max (2026-11-01)',
      'Step "day": min must be a Date or a "YYYY-MM-DD" day, got "2026-13-01"',
      'Unknown time zone "Nowhere/Land": use an IANA name such as "Asia/Jakarta", "Europe/Berlin" or "UTC"',
    ]);
  });
});
