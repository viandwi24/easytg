import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions, type InvoiceContent } from '../src';
import { createTestBot } from '../src/testing';

const stars = (payload: string): InvoiceContent => ({
  title: 'Pro plan',
  description: '30 days of Pro',
  payload,
  currency: 'XTR',
  prices: [{ label: 'Pro', amount: 100 }],
});

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 }, ...options });
  t.bot.use(app);
  const checkout = page('checkout').render(({ nav }) => ({
    invoice: stars('pro:30'),
    keyboard: [[nav.pay('⭐ Pay 100')], [nav.button('Cancel', 'home')]],
  }));
  const home = page('home').render(({ nav }) => ({ text: 'Home', keyboard: [[nav.button('Buy Pro', checkout)]] }));
  app.register(home, checkout);
  return { ...t, app, checkout };
}

const user = { id: 7, is_bot: false, first_name: 'Ann' };

describe('payments', () => {
  test('invoice content is sent with sendInvoice; a menu button replaces the menu', async () => {
    const { press, find, methods } = setup();
    await press('p|checkout');
    expect(methods()).toContain('deleteMessage');
    const [call] = find('sendInvoice');
    expect(call!.payload).toMatchObject({ chat_id: 7, title: 'Pro plan', payload: 'pro:30', currency: 'XTR', prices: [{ label: 'Pro', amount: 100 }] });
    expect(call!.payload.reply_markup.inline_keyboard[0][0]).toEqual({ text: '⭐ Pay 100', pay: true });
  });

  test('invoices reject text, other media and keyboards without a Pay button first', async () => {
    const { app, press, find } = setup();
    let failure: unknown;
    app.on('error', ({ error }) => void (failure = error));
    app.register(page('bad').render(({ nav }) => ({ invoice: stars('x'), keyboard: [[nav.home()]] })));
    await press('p|bad');
    expect(String(failure)).toMatch(/first button of an invoice keyboard must be nav.pay/);
    app.register(page('bad2').render(() => ({ invoice: stars('x'), text: 'hi' })));
    await press('p|bad2');
    expect(String(failure)).toMatch(/can't have text/);
    expect(find('sendInvoice').length).toBe(0);
  });

  test('without the payments option, checkout and payments go to your handlers', async () => {
    const { bot, update } = setup();
    const seen: string[] = [];
    bot.on('pre_checkout_query', () => void seen.push('checkout'));
    bot.on('message:successful_payment', () => void seen.push('paid'));
    await update({ pre_checkout_query: { id: 'q', from: user, currency: 'XTR', total_amount: 100, invoice_payload: 'p' } });
    await update({ message: paymentMessage('p') });
    expect(seen).toEqual(['checkout', 'paid']);
  });

  test('preCheckout accepts or refuses with a message', async () => {
    const { update, find } = setup({
      payments: { preCheckout: ({ payload }) => (payload === 'sold-out' ? 'Sorry, sold out' : true) },
    });
    await update({ pre_checkout_query: { id: 'a', from: user, currency: 'XTR', total_amount: 100, invoice_payload: 'pro:30' } });
    await update({ pre_checkout_query: { id: 'b', from: user, currency: 'XTR', total_amount: 100, invoice_payload: 'sold-out' } });
    expect(find('answerPreCheckoutQuery').map((c) => c.payload)).toEqual([
      { pre_checkout_query_id: 'a', ok: true },
      { pre_checkout_query_id: 'b', ok: false, error_message: 'Sorry, sold out' },
    ]);
  });

  test('onSuccess shows its result; the payment event carries the payload', async () => {
    const { app, bot, update, find } = setup({
      payments: {
        onSuccess: ({ payload, session, nav }) => {
          session.set('plan', payload);
          return { text: `Thanks! ${payload} is active.`, parseMode: 'plain', keyboard: [[nav.home()]] };
        },
      },
    });
    const events: string[] = [];
    app.on('payment', ({ payload, payment }) => void events.push(`${payload}:${payment.total_amount}`));
    let after = false;
    bot.on('message', () => void (after = true));
    await update({ message: paymentMessage('pro:30') });
    expect(events).toEqual(['pro:30:100']);
    expect(find('sendMessage')[0]!.payload.text).toBe('Thanks! pro:30 is active.');
    expect(after).toBe(false);
  });
});

function paymentMessage(payload: string) {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 7, type: 'private' as const, first_name: 'Ann' },
    from: user,
    successful_payment: {
      currency: 'XTR',
      total_amount: 100,
      invoice_payload: payload,
      telegram_payment_charge_id: 'tg1',
      provider_payment_charge_id: 'pr1',
    },
  };
}
