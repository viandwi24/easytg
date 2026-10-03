/**
 * An AI chat: answers appear word by word while they are generated, with a
 * stop button, like the AI apps. No API key needed: a small fake model
 * streams the answers; swap in your model's streaming API (Claude, OpenAI…).
 *
 *   BOT_TOKEN=123:abc bun run examples/ai-chat.ts
 *
 * Send any question. In a private chat the answer streams as a Telegram
 * draft ("Thinking…", then the text growing, Bot API 10) with a ⏹ Stop
 * button; in a group, as a message that grows. Models answer in Markdown, so
 * the answer is a rich message (Bot API 10.3): its table and list show
 * formatted while it is written.
 *
 * Shows: `app.stream` with an `AbortSignal` for the stop button, `rich`,
 * `finish` for the final message, `stoppable`, `escapeRichMarkdown`, and why
 * the stream isn't awaited in the handler (so the stop update can be handled
 * while it runs).
 */
import { Bot } from 'grammy';
import { EasyTG, escapeRichMarkdown, page, type StreamSource } from '../src';

/**
 * Stands in for a model's streaming API. With a real one, pass `signal` on,
 * so pressing stop cancels the request too:
 *
 *   const stream = await anthropic.messages.stream({ model, messages, max_tokens }, { signal });
 *   for await (const event of stream) if (event.type === 'content_block_delta') yield event.delta.text;
 */
function fakeModel(question: string): StreamSource {
  return async function* (signal) {
    const answer = [
      `You asked: **${escapeRichMarkdown(question)}**`,
      '',
      'Here is a thought, written slowly so you can watch it arrive. Streaming lets people start reading before the answer is done, and the stop button lets them cut a long answer short.',
      '',
      '| Answer | Feels |',
      '|:-------|:------|',
      '| Short | instant |',
      '| Long | readable while it grows |',
      '',
      '- Pressing stop keeps what was written so far.',
    ].join('\n');
    for (const word of answer.split(/(?<=\s)/)) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 60));
      yield word;
    }
  };
}

const home = page('home').render(() => ({
  text: ['🤖 **Ask me anything.**', 'Your question streams back word by word. Press ⏹ Stop to cut it short.'],
}));

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/ai-chat.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG().command('start', home, { description: 'What this bot does' });
bot.use(app);

bot.on('message:text', (ctx) => {
  const question = ctx.message.text;
  // Not awaited: `bot.start()` handles one update at a time, and the stop
  // button arrives as an update. Returning right away lets it through.
  // (With webhooks or @grammyjs/runner you can simply `await` it.)
  void app
    .stream(ctx, fakeModel(question), {
      rich: true, // the answer is Markdown: formatted while it grows, and in the final message
      stoppable: true,
      // An empty line first: "Stopped" must not continue a table or a list cut off mid-way.
      finish: (text, { stopped }) => ({ rich: [text.trim(), stopped ? '\n_⏹ Stopped_' : ''] }),
    })
    .catch((error) => console.error('stream failed', error));
});

bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Ask it something.`) });
