import { expect, test } from 'bun:test';
import { EasyTG, dialogue, page } from '../src';

// Compile-time checks: `bun run typecheck` fails if any @ts-expect-error is unused.
// Pages and dialogues reference each other in a cycle, each defined in one expression.

const home = page('home').render(({ nav }) => ({
  keyboard: [[nav.button('Order', order, { id: '1' }), nav.button('Sign up', signup, { ref: 'home' })]],
}));

const order = page<{ id: string; tab?: string }>('order').render(({ params, nav, app, ctx }) => {
  const id: string = params.id;
  const tab: string | undefined = params.tab;

  nav.button('ok', order, { id: 1, tab: 'x' });
  nav.button('ok', home);
  nav.redirect(order, { id: '2' });
  void app.open(ctx, order, { id: '3' }, { mode: 'send' });
  void app.open(ctx, home);

  // @ts-expect-error missing required param
  nav.button('bad', order);
  // @ts-expect-error unknown param
  nav.button('bad', order, { id: '1', nope: 1 });
  // @ts-expect-error wrong param type
  nav.button('bad', order, { id: {} });
  // @ts-expect-error missing dialogue param
  nav.startDialogue(signup);
  // @ts-expect-error missing page param
  void app.open(ctx, order);

  return { text: `${id} ${tab}`, keyboard: [[nav.home()]] };
});

const signup = dialogue<{ name: string }, { ref: string }>('signup')
  .steps([{ id: 'name', type: 'text', text: 'Name?' }])
  .onFinish(({ answers, params, nav }) => {
    const name: string = answers.name;
    const ref: string = params.ref;
    return { text: `${name} via ${ref}`, keyboard: [[nav.button('Back', home)]] };
  });

// Declared params must be strings, since that's what arrives at runtime.
interface ProductParams {
  sku: string;
  ref?: string;
}
page<ProductParams>('product').render(({ params }) => ({ text: params.sku })); // interfaces are fine
// @ts-expect-error numbers would be a lie: params are strings at runtime
page<{ id: number }>('bad-number');
// @ts-expect-error same for dialogues
dialogue<{}, { count: number }>('bad-dialogue');

page('api').render(({ app, ctx, nav }) => {
  void app.open(ctx, home, undefined, { mode: 'send' });
  void app.startDialogue(ctx, signup, { ref: 'x' });
  // @ts-expect-error startDialogue requires the dialogue's params
  void app.startDialogue(ctx, signup);
  // @ts-expect-error mode is an option now, not a positional string
  void app.open(ctx, home, {}, 'send');
  return { photo: 'FILE', keyboard: [[nav.home()]] };
});

// `.params(parse)`: render sees the parsed type, links keep the raw one, and
// pages using it can still reference each other in cycles.
const episode = page<{ id: string }>('episode')
  .params((raw) => ({ id: Number(raw.id) }))
  .render(({ params, nav }) => {
    const id: number = params.id;
    // @ts-expect-error parsed params are numbers, not strings
    const wrong: string = params.id;
    return { text: `${id}${wrong}`, keyboard: [[nav.button('Next', episode, { id: id + 1 }), nav.button('List', episodes)]] };
  });
const episodes = page('episodes').render(({ nav }) => ({
  keyboard: [
    [nav.button('First', episode, { id: '1' })],
    // @ts-expect-error links still need the raw params
    [nav.button('Broken', episode)],
  ],
}));

test('typed navigation compiles', () => {
  expect(new EasyTG({ logger: false }).register(home, order, signup, episode, episodes)).toBeDefined();
});
