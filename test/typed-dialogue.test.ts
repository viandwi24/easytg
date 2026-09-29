import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, type Auto, type DialogueFile, type StandardSchemaV1 } from '../src';
import { createTestBot } from '../src/testing';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type AnswersOf<D> = D extends { onFinish(fn: (args: { answers: infer A }) => unknown): unknown } ? A : never;

/** Like zod's `z.coerce.number()`. */
const number = (): StandardSchemaV1<unknown, number> => ({
  '~standard': { version: 1, vendor: 'test', validate: (v) => (Number.isFinite(Number(v)) ? { value: Number(v) } : { issues: [{ message: 'not a number' }] }) },
});

describe('answers inferred from the steps', () => {
  test('ids, choice values, schema outputs, file steps and `when`', () => {
    const signup = dialogue('signup').steps([
      { id: 'name', type: 'text', text: 'Name?' },
      { id: 'age', type: 'text', text: 'Age?', schema: number() },
      { id: 'plan', type: 'choice', text: 'Plan?', options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
      { id: 'logo', type: 'file', text: 'Logo?', when: ({ answers }) => answers.plan === 'pro' },
    ]);
    type _ = Expect<Equal<AnswersOf<typeof signup>, { name: string; age: number; plan: 'free' | 'pro'; logo?: DialogueFile }>>;
    signup.onFinish(({ answers }) => {
      answers.plan satisfies 'free' | 'pro';
      // @ts-expect-error not a step
      void answers.nmae;
    });
    expect(signup.id).toBe('signup');
  });

  test('a steps function with branches: keys not in every branch are optional', () => {
    const d = dialogue('d').steps(({ answers }) =>
      answers.more
        ? [{ id: 'a', type: 'text', text: 'A' }, { id: 'b', type: 'file', text: 'B' }]
        : [{ id: 'a', type: 'text', text: 'A' }],
    );
    type _ = Expect<Equal<AnswersOf<typeof d>, { a: string; b?: DialogueFile }>>;
    expect(d.id).toBe('d');
  });

  test('declared answers win; steps built in a loop stay untyped', () => {
    const declared = dialogue<{ name: string }>('declared').steps([{ id: 'name', type: 'text', text: 'N' }]);
    type _1 = Expect<Equal<AnswersOf<typeof declared>, { name: string }>>;

    const withParams = dialogue<Auto, { ref: string }>('p').steps([{ id: 'x', type: 'text', text: 'X' }]);
    type _2 = Expect<Equal<AnswersOf<typeof withParams>, { x: string }>>;

    const ids = ['a', 'b'];
    const loop = dialogue('loop').steps(ids.map((id) => ({ id, type: 'text' as const, text: id })));
    loop.onFinish(({ answers }) => void answers.anything);
    expect(loop.id).toBe('loop');
  });
});

describe('when', () => {
  test('a step is asked only when `when` says so', async () => {
    const t = createTestBot();
    const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
    t.bot.use(app);
    let finished: unknown;
    const d = dialogue('d')
      .steps([
        { id: 'plan', type: 'text', text: 'Plan?' },
        { id: 'company', type: 'text', text: 'Company?', when: ({ answers }) => answers.plan === 'pro' },
        { id: 'email', type: 'text', text: 'Email?' },
      ])
      .onFinish(({ answers }) => void (finished = answers));
    app.register(d);
    t.bot.command('go', (ctx) => app.startDialogue(ctx, d));

    await t.message('/go');
    await t.message('free');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Email?');
    await t.message('a@b.c');
    expect(finished).toEqual({ plan: 'free', email: 'a@b.c' });

    await t.message('/go');
    await t.message('pro');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Company?');
    await t.message('ACME');
    await t.message('x@y.z');
    expect(finished).toEqual({ plan: 'pro', company: 'ACME', email: 'x@y.z' });
  });
});
