import { describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  EasyTG,
  MemoryStorage,
  WebAppAuthError,
  dialogue,
  miniAppLink,
  page,
  replyMenu,
  verifyInitData,
  verifyInitDataSignature,
  type EasyTGEvents,
  type StandardSchemaV1,
} from '../src';
import { createTestBot } from '../src/testing';

const TOKEN = '1:TEST';

/** initData as Telegram would build it. */
function initData(fields: Record<string, string>, token = TOKEN) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = () => String(Math.floor(Date.now() / 1000));
const user = JSON.stringify({ id: 7, first_name: 'Ann', language_code: 'en' });

describe('verifyInitData', () => {
  test('accepts initData signed with the bot token and parses it', () => {
    const data = verifyInitData(initData({ user, auth_date: now(), query_id: 'Q1', start_param: 'item_42' }), TOKEN);
    expect(data.user).toMatchObject({ id: 7, first_name: 'Ann' });
    expect(data).toMatchObject({ queryId: 'Q1', startParam: 'item_42' });
    expect(data.authDate).toBeInstanceOf(Date);
  });

  test('rejects forged, malformed and old initData', () => {
    const good = initData({ user, auth_date: now() });
    const forged = good.replace('Ann', 'Bob');
    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as WebAppAuthError).reason;
      }
    };
    expect(reason(() => verifyInitData(forged, TOKEN))).toBe('invalid');
    expect(reason(() => verifyInitData(good, '2:OTHER'))).toBe('invalid');
    expect(reason(() => verifyInitData('user=x', TOKEN))).toBe('malformed');
    const old = initData({ user, auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400) });
    expect(reason(() => verifyInitData(old, TOKEN))).toBe('expired');
    expect(verifyInitData(old, TOKEN, { maxAgeMs: Infinity }).user?.id).toBe(7);
  });

  test('signature (Ed25519, no bot token needed)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
    const fields = { user, auth_date: now() };
    const message = `1:WebAppData\n${Object.keys(fields).sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('\n')}`;
    const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');
    const signed = new URLSearchParams({ ...fields, signature, hash: 'x' }).toString();
    expect((await verifyInitDataSignature(signed, 1, { publicKey: raw })).user?.id).toBe(7);
    await expect(verifyInitDataSignature(signed, 2, { publicKey: raw })).rejects.toThrow(WebAppAuthError);
  });
});

test('miniAppLink', () => {
  expect(miniAppLink('shop_bot')).toBe('https://t.me/shop_bot?startapp');
  expect(miniAppLink('shop_bot', { app: 'store', startParam: 'item_42', mode: 'compact' })).toBe(
    'https://t.me/shop_bot/store?startapp=item_42&mode=compact',
  );
  expect(() => miniAppLink('shop_bot', { startParam: 'a b' })).toThrow();
});

function setup(options: ConstructorParameters<typeof EasyTG>[0] = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options });
  t.bot.use(app);
  return { ...t, app };
}

const webAppData = (data: string, button = '📱 Open') => ({ extra: { text: undefined, web_app_data: { data, button_text: button } } });

describe('Mini Apps in the bot', () => {
  test('replyMenu.webApp opens the Mini App; its data arrives as the webAppData event', async () => {
    const menu = replyMenu([[replyMenu.webApp('🛒 Shop', 'https://example.com/shop')]]);
    const { app, bot, message, find } = setup({ menu });
    const events: EasyTGEvents['webAppData'][] = [];
    app.on('webAppData', (e) => void events.push(e));
    let passedOn = false;
    bot.command('start', (ctx) => app.showMenu(ctx, 'Hi'));
    bot.on('message:web_app_data', () => void (passedOn = true));
    await message('/start');
    expect(find('sendMessage')[0]!.payload.reply_markup.keyboard[0][0]).toEqual({ text: '🛒 Shop', web_app: { url: 'https://example.com/shop' } });
    await message('', webAppData('{"item":42}', '🛒 Shop'));
    expect(events[0]).toMatchObject({ data: { item: 42 }, raw: '{"item":42}', button: '🛒 Shop' });
    expect(passedOn).toBe(true);
    expect(() => replyMenu.webApp('x', 'http://insecure')).toThrow();
  });

  test('a webApp dialogue step takes the data, checked by a schema', async () => {
    const date: StandardSchemaV1<unknown, { date: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => (typeof (v as { date?: unknown })?.date === 'string' ? { value: v as { date: string } } : { issues: [{ message: 'Pick a date' }] }),
      },
    };
    const { app, bot, message, find } = setup();
    let answer: unknown;
    const book = dialogue('book')
      .steps([{ id: 'when', type: 'webApp', url: 'https://example.com/calendar', text: 'Pick a date', schema: date }])
      .onFinish(({ answers }) => void (answer = answers.when.date));
    app.register(book);
    bot.command('book', (ctx) => app.startDialogue(ctx, book));
    await message('/book');
    const button = find('sendMessage')[0]!.payload.reply_markup.keyboard[0][0];
    expect(button).toEqual({ text: app.texts.openWebApp, web_app: { url: 'https://example.com/calendar' } });
    await message('', webAppData('{"nope":1}'));
    expect(find('sendMessage').map((c) => c.payload.text)).toContain('Pick a date');
    await message('', webAppData('{"date":"2026-10-01"}'));
    expect(answer).toBe('2026-10-01');
  });

  test('withUser: act as a user from your server, saved like an update', async () => {
    const storage = new MemoryStorage();
    const { app, bot } = setup({ storage });
    const plan = await app.withUser(bot, 7, async ({ session, userSession }) => {
      userSession.set('plan', 'pro');
      session.set('lastOrder', 42);
      return 'pro';
    });
    expect(plan).toBe('pro');
    expect(await storage.get('usersession:1:7')).toMatchObject({ data: { plan: 'pro' } });
    expect(await storage.get('session:1:7:7')).toMatchObject({ data: { lastOrder: 42 } });
  });

  test('answerWebAppQuery and prepareShare send a page', async () => {
    const { app, bot, find, responders } = setup({ buttons: { params: 'stored' } });
    const card = page<{ id: string }>('card').render(({ params, nav }) => ({
      text: `Order ${params.id}`,
      parseMode: 'plain',
      keyboard: [[nav.self('Refresh')]],
    }));
    app.register(card);
    await app.answerWebAppQuery(bot, 'Q1', card, { userId: 7, params: { id: '42' }, title: 'Order' });
    const answered = find('answerWebAppQuery')[0]!.payload;
    expect(answered).toMatchObject({ web_app_query_id: 'Q1', result: { type: 'article', title: 'Order', input_message_content: { message_text: 'Order 42' } } });

    responders.savePreparedInlineMessage = () => ({ id: 'P1', expiration_date: 2_000_000_000 });
    const prepared = await app.prepareShare(bot, 7, card, { params: { id: '42' }, title: 'Order' });
    expect(prepared.id).toBe('P1');
    expect(find('savePreparedInlineMessage')[0]!.payload).toMatchObject({ user_id: 7, allow_group_chats: true, allow_bot_chats: false });
  });
});
