import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, autoRetry, dialogue, page, type EasyTGOptions, type StandardSchemaV1 } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

/** A minimal Standard Schema, like zod's `z.coerce.number().int().min(min)`. */
function integer(min = 0): StandardSchemaV1<unknown, number> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= min ? { value: n } : { issues: [{ message: `Expected an integer ≥ ${min}` }] };
      },
    },
  };
}

function object<S extends Record<string, StandardSchemaV1<unknown, unknown>>>(shape: S): StandardSchemaV1<unknown, { [K in keyof S]: S[K] extends StandardSchemaV1<unknown, infer O> ? O : never }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async (value) => {
        const out: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(shape)) {
          const result = await schema['~standard'].validate((value as Record<string, unknown>)[key]);
          if (result.issues) return { issues: result.issues.map((i) => ({ ...i, path: [key] })) };
          out[key] = result.value;
        }
        return { value: out as never };
      },
    },
  };
}

describe('dialogue timeout', () => {
  test('an idle dialogue ends; late text goes to the app', async () => {
    const { app, bot, message } = setup({ dialogues: { timeoutMs: 60_000 } });
    const reasons: string[] = [];
    app.on('dialogueCancel', ({ reason }) => void reasons.push(reason));
    const ask = dialogue<{ a: string }>('ask').steps([{ id: 'a', type: 'text', text: 'a?' }]).onFinish(() => undefined);
    const quick = dialogue<{ a: string }>('quick').timeout(5_000).steps([{ id: 'a', type: 'text', text: 'a?' }]).onFinish(() => undefined);
    app.register(ask, quick);
    const seen: string[] = [];
    bot.command('ask', (ctx) => app.startDialogue(ctx, ask));
    bot.command('quick', (ctx) => app.startDialogue(ctx, quick));
    bot.on('message:text', (ctx) => void seen.push(ctx.message.text));

    try {
      await message('/ask');
      setSystemTime(new Date(Date.now() + 30_000));
      await message('still here'); // answered in time
      expect(seen).toEqual([]);

      await message('/quick');
      setSystemTime(new Date(Date.now() + 10_000)); // the dialogue's own timeout wins
      await message('too late');
      expect(seen).toEqual(['too late']);
      expect(reasons).toEqual(['timeout']);
    } finally {
      setSystemTime();
    }
  });
});

describe('Standard Schema', () => {
  test('page params are validated and converted', async () => {
    const { app, bot, message, press, find } = setup();
    let got: unknown;
    const episode = page<{ id: string }>('episode')
      .params(object({ id: integer(1) }))
      .render(({ params }) => ((got = params), { text: `episode ${params.id + 1}`, parseMode: 'plain' }));
    app.register(episode);
    bot.command('e', (ctx) => app.open(ctx, episode, { id: '41' }));
    await message('/e');
    expect(got).toEqual({ id: 41 });
    expect(find('sendMessage')[0]!.payload.text).toBe('episode 42');

    await press('p|episode|id=abc');
    expect(find('answerCallbackQuery').at(-1)!.payload.text).toBe(app.texts.pageNotFound);
  });

  test('a text step converts its answer; the first issue is the error', async () => {
    const { app, bot, message, find } = setup();
    let answers: unknown;
    const d = dialogue<{ age: number }>('age')
      .steps([{ id: 'age', type: 'text', text: 'Age?', schema: integer(18) }])
      .onFinish((args) => void (answers = args.answers));
    app.register(d);
    bot.command('go', (ctx) => app.startDialogue(ctx, d));
    await message('/go');
    await message('12');
    expect(find('sendMessage').map((c) => c.payload.text)).toContain('Expected an integer ≥ 18');
    await message('30');
    expect(answers).toEqual({ age: 30 });
  });
});

describe('languages', () => {
  const messages = { en: { saved: 'Saved', hi: 'Hi' }, id: { saved: 'Disimpan', hi: 'Halo' } };

  test('setLocale applies at once and to later sends', async () => {
    const { app, bot, message, find, reset } = setup({ i18n: { messages } });
    const picker = page<{ set?: string }>('lang').render(async ({ ctx, params, t }) => {
      if (params.set) await app.setLocale(ctx, params.set);
      return { text: t('saved'), parseMode: 'plain' };
    });
    const hello = page('hello').render(({ t }) => ({ text: t('hi'), parseMode: 'plain' }));
    app.register(picker, hello);
    bot.command('id', (ctx) => app.open(ctx, picker, { set: 'id' }));
    await message('/id', { language: 'en' });
    expect(find('sendMessage')[0]!.payload.text).toBe('Disimpan');
    reset();
    await app.sendTo(bot, { chatId: 7, userId: 7 }, hello);
    expect(find('sendMessage')[0]!.payload.text).toBe('Halo');
  });

  test('messages sent later use the language the user last wrote in', async () => {
    const { app, bot, message, find, reset } = setup({ i18n: { messages } });
    const hello = page('hello').render(({ t }) => ({ text: t('hi'), parseMode: 'plain' }));
    app.register(hello);
    bot.on('message', () => undefined);
    await message('hai', { language: 'id' });
    reset();
    await app.sendTo(bot, { chatId: 7, userId: 7 }, hello);
    expect(find('sendMessage')[0]!.payload.text).toBe('Halo');
  });
});

describe('app.answer', () => {
  test('answers the press early, once', async () => {
    const { app, press, find } = setup();
    app.register(
      page('slow').render(async ({ ctx }) => {
        await app.answer(ctx, 'Working…');
        return { text: 'done', toast: 'ignored' };
      }),
    );
    await press('p|slow');
    expect(find('answerCallbackQuery').map((c) => c.payload.text)).toEqual(['Working…']);
  });
});

describe('autoRetry', () => {
  test('waits out 429 answers; other errors are returned', async () => {
    const retry = autoRetry({ maxRetries: 2 });
    let calls = 0;
    const tooMany = { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.01 } };
    const prev = (async () => (++calls < 3 ? tooMany : { ok: true, result: true })) as never;
    expect(await retry(prev, 'sendMessage', {} as never)).toEqual({ ok: true, result: true } as never);
    expect(calls).toBe(3);

    calls = 0;
    const bad = { ok: false, error_code: 400, description: 'Bad Request' };
    expect(await retry((async () => (calls++, bad)) as never, 'sendMessage', {} as never)).toEqual(bad as never);
    expect(calls).toBe(1);
  });
});
