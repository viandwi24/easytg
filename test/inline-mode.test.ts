// Inline mode: pages as inline results.
import { describe, expect, test } from 'bun:test';
import type { InlineQueryResult } from 'grammy/types';
import { EasyTG, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

describe('inline mode', () => {
  test('pages become inline results whose buttons work in the sent message', async () => {
    const { app, bot, update, press, find } = setup({ buttons: { params: 'stored' } });
    const product = page<{ id: string }>('product').render(({ params, nav }) => ({
      text: `Product ${params.id}`,
      parseMode: 'plain',
      keyboard: [[nav.self('Refresh', { id: params.id })]],
    }));
    app.register(product);
    let results: InlineQueryResult[] = [];
    bot.on('inline_query', async (ctx) => {
      results = [await app.inlineResult(ctx, product, { params: { id: '7' }, title: 'Product 7' })];
    });
    await update({ inline_query: { id: 'q', from: user(7), query: 'p', offset: '' } });
    const article = results[0] as Extract<InlineQueryResult, { type: 'article' }>;
    expect(article).toMatchObject({ type: 'article', title: 'Product 7', input_message_content: { message_text: 'Product 7' } });

    const data = article.reply_markup!.inline_keyboard[0]![0]! as { callback_data: string };
    await update({ callback_query: { id: 'c', from: user(8), chat_instance: 'x', inline_message_id: 'IM', data: data.callback_data } });
    expect(find('editMessageText')[0]!.payload).toMatchObject({ inline_message_id: 'IM', text: 'Product 7' });
  });
});
