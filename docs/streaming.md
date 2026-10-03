# Streaming text

`app.stream` shows text while it is being generated, an AI model's answer for
example, and sends it as a normal message when it is done:

```ts
bot.on('message:text', (ctx) => {
  void app
    .stream(ctx, (signal) => model.stream(ctx.message.text, { signal }), {
      stoppable: true,
      finish: (text, { stopped }) => ({ text: stopped ? `${text}\n\n_⏹ Stopped_` : text }),
    })
    .catch((error) => console.error('stream failed', error));
});
```

- **Private chats:** the preview is a Telegram draft (Bot API 10,
  `sendMessageDraft`): "Thinking…" until the first words arrive, then the
  text growing in an animated bubble. Drafts are previews only; they disappear
  when the final message is sent.
- **Groups:** drafts are for private chats, so a "…" message is sent and
  edited as the text grows. The final text goes into that same message.
- **The final message** is `finish(text, { stopped })`, a page's content:
  formatting, a keyboard, media. Without `finish` it is the text, trimmed, as
  Markdown. Long text is split like any page. Previews are plain text, since
  half a Markdown answer (`**bold`) isn't valid formatting yet; with
  [`rich`](#rich-answers) they are formatted.
- `intervalMs` is the least time between previews: 300 ms for drafts, 1000 ms
  for edits in groups (Telegram limits edits per chat).

`app.stream` resolves with `{ text, stopped, result }`, `result` being the
final message as `app.open` returns it. An error from the source rejects it;
the preview is left as it was.

## The source

Anything that yields text chunks: an `AsyncIterable<string>`, or a function
taking an `AbortSignal` and returning one. Pass the signal on to your model's
API so that stopping cancels the request too:

```ts
// Anthropic's SDK
const source: StreamSource = async function* (signal) {
  const stream = anthropic.messages.stream({ model, max_tokens: 1024, messages }, { signal });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
  }
};
```

## Rich answers

Models answer in Markdown: headings, lists, tables, code. With `rich: true`
the text is [Rich Markdown](rich-messages.md): previews are rich drafts
(`sendRichMessageDraft`; rich edits in groups), so the table shows as a
table while it grows, and the final message is a rich message:

```ts
void app.stream(ctx, source, {
  rich: true,
  stoppable: true,
  // An empty line first: "Stopped" must not continue a table cut off mid-way.
  finish: (text, { stopped }) => ({ rich: [text.trim(), stopped ? '\n_⏹ Stopped_' : ''] }),
});
```

A preview Telegram refuses (half-written HTML, say) is skipped and the next
one shows; previews go up to 32768 characters. Put user input into the
answer with `escapeRichMarkdown`. [`examples/ai-chat.ts`](../examples/ai-chat.ts) does
this.

## The stop button

`stoppable: true` puts a ⏹ Stop button on the draft (private chats). Pressing
it sends the bot a `stopped_message_generation` update; easytg aborts the
source's signal, and the text so far becomes the final message
(`stopped: true`).

The stop arrives as an **update**, so the handler that streams must not hold up
the next updates. With `bot.start()`, grammY handles one update at a time:
don't `await` the stream in the handler (`void app.stream(...).catch(...)`
as above), or the stop waits until the answer is complete. With webhooks or
`@grammyjs/runner`, updates run concurrently and `await` is fine.

## Try it

[`examples/ai-chat.ts`](../examples/ai-chat.ts) is an AI chat with a fake
model, so it runs without an API key. Ask anything, then press ⏹ Stop while it
writes:

```ts playground start="Tell me something"
import { Bot } from 'grammy';
import { EasyTG, md, type StreamSource } from 'easytg';

// Stands in for a model: the answer, word by word.
const fakeModel = (question: string): StreamSource =>
  async function* (signal) {
    const answer = `You asked: **${question}**\n\nStreaming lets people read while the answer is written. Press stop to keep what is there so far, and to cut a long answer short.`;
    for (const word of answer.split(/(?<=\s)/)) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield word;
    }
  };

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG();
bot.use(app);
bot.on('message:text', (ctx) => {
  void app
    .stream(ctx, fakeModel(ctx.message.text.replace(/[*_`[\]]/g, '')), {
      stoppable: true,
      finish: (text, { stopped }) => ({ text: [text.trim(), stopped ? md`\n_⏹ Stopped_` : ''] }),
    })
    .catch((error) => console.error(error));
});
bot.start();
```

In the [simulator](simulator.md), `sim.chat(userId).draft` is the draft on
screen and `sim.stopGeneration(chatId)` presses ⏹ Stop.
