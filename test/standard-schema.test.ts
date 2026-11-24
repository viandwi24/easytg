// Standard Schema validation of page params and dialogue answers.
import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, page, type EasyTGOptions, type StandardSchemaV1 } from '../src';
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
