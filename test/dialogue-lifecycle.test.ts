// Dialogues: timeouts, and collect steps after errors.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, dialogue, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
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

describe('dialogues', () => {
  test('collect keeps its Done button after an error and starts over after a failed validation', async () => {
    const { app, bot, message, press, button, find, reset, sent } = setup();
    let answer: unknown;
    const d = dialogue<{ notes: { texts: string[] } }>('notes')
      .steps([{ id: 'notes', type: 'collect', accept: ['text'], text: 'Send notes', validate: (items) => items.texts.length <= 2 || 'max 2' }])
      .onFinish(({ answers }) => void (answer = answers.notes.texts));
    app.register(d);
    bot.command('go', (ctx) => app.startDialogue(ctx, d));
    await message('/go');
    await message('one');
    await message('', { extra: { text: undefined, sticker: { file_id: 'S', file_unique_id: 's' } } });
    const prompt = find('sendMessage').at(-1)!.payload;
    expect(prompt.text).toBe('Send notes');
    expect(prompt.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)).toContain(app.texts.done);

    await message('two');
    await message('three');
    const done = button(app.texts.done);
    reset();
    await press(done, { messageId: sent.at(-1)!.message_id });
    const after = find('sendMessage').at(-1)!.payload;
    expect(after.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)).not.toContain(app.texts.done);

    await message('four');
    await press(button(app.texts.done), { messageId: sent.at(-1)!.message_id });
    expect(answer).toEqual(['four']);
  });
});
