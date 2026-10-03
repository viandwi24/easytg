import { expect, test } from 'bun:test';
import { EasyTG, dialogue, mermaidLiveUrl, page, replyMenu } from '../src';
import { TelegramSimulator } from '../src/simulator';

test('flowchart: commands, menu, and the buttons, redirects and dialogues seen', async () => {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const orders = page('orders').render(({ nav }) => ({ text: 'Orders', keyboard: [[nav.home()]] }));
  const product = page<{ id: string }>('product').render(({ params, nav }) =>
    params.id === 'gone' ? nav.redirect(home) : { text: 'A product', keyboard: [[nav.button('🛒 Order', order, { id: params.id })], [nav.back()]] },
  );
  const home = page('home').render(({ nav }) => ({ text: 'Home', keyboard: [[nav.button('🛍 Tea', product, { id: 'tea' })], [nav.button('Old "link"', product, { id: 'gone' })]] }));
  const order = dialogue('order')
    .steps([{ id: 'n', type: 'text', text: 'How many?' }])
    .onFinish(({ nav }) => nav.redirect(orders));
  const app = new EasyTG({ logger: false, menu: replyMenu([[replyMenu.button('🧾 Orders', orders)]]), buttons: { doubleTapMs: 0 } })
    .register(product, order, orders)
    .command('start', home, { description: 'Home' });
  bot.use(app);

  expect(app.flowchart({ observed: false })).toBe(
    ['flowchart LR', '  n0["product"]', '  n1["orders"]', '  n2["home"]', '  n3(["📝 order"])', '  n4[/"/start"/]', '  n4 --> n2', '  n5>"🧾 Orders"]', '  n5 --> n1'].join('\n'),
  );

  await sim.send('/start');
  await sim.tap('🛍 Tea');
  await sim.tap('🛒 Order');
  await sim.send('2');
  await sim.send('/start');
  await sim.tap('Old "link"');

  const chart = app.flowchart();
  expect(chart).toContain('n2 -->|"🛍 Tea · Old #quot;link#quot;"| n0'); // two buttons, one arrow
  expect(chart).toContain('n0 -->|"🛒 Order"| n3');
  expect(chart).toContain('n3 -.->|redirect| n1'); // the dialogue's onFinish
  expect(chart).toContain('n0 -.->|redirect| n2');
  expect(chart).toContain('n1 -->|"🏠 Home"| n2');
  expect(mermaidLiveUrl(chart)).toStartWith('https://mermaid.live/edit#base64:');
});

test('flowchart marks targets that were never registered', () => {
  const lost = page('lost').render(() => ({ text: 'lost' }));
  const app = new EasyTG({ logger: false, menu: replyMenu([[replyMenu.button('Lost', lost)]]) });
  expect(app.flowchart()).toBe(['flowchart LR', '  n0>"Lost"]', '  n1["⚠️ lost (not registered)"]:::missing', '  n0 --> n1', '  classDef missing stroke:#e5484d,stroke-width:2px,stroke-dasharray:4'].join('\n'));
});

test('flowchart stays small with labels that change (counters, names)', async () => {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  let n = 0;
  const counter = page('counter').render(({ nav }) => ({ text: 'Count', keyboard: [[nav.button(`Pressed ${n++} times`, other)]] }));
  const other = page('other').render(({ nav }) => ({ text: 'Other', keyboard: [[nav.button('Back', counter)]] }));
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } }).register(other).command('start', counter);
  bot.use(app);
  for (let i = 0; i < 50; i++) await sim.send('/start');
  const chart = app.flowchart();
  expect(chart.split('\n').filter((l) => l.includes('-->|'))).toEqual(['  n1 -->|"Pressed 0 times · Pressed 1 times · Pressed 2 times"| n0']);
});
