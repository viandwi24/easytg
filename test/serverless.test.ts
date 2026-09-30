import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '../src/simulator';
import { interceptBotApi } from '../src/simulator/load';
import worker from '../examples/cloudflare-worker';

// The Worker's handlers, fed webhook requests; its Telegram calls go to a simulator.
const sim = new TelegramSimulator();
const restore = interceptBotApi((request) => sim.handleRequest(request));
afterAll(restore);
const env = { BOT_TOKEN: sim.token, WEBHOOK_SECRET: 's3cret' };
let updateId = 1;

async function webhook(update: object, secret = 's3cret') {
  const request = new Request('https://bot.example.workers.dev/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
  return worker.fetch(request, env);
}

const user = { id: 7, is_bot: false, first_name: 'Ann' };
const chat = { id: 7, type: 'private', first_name: 'Ann' };

test('the Worker answers webhooks and runs due tasks from its cron handler', async () => {
  sim.addUser(user);
  sim.privateChat(7).started = true; // Ann has talked to the bot, so it may write to her
  expect((await webhook({ message: { message_id: 1, date: 1, chat, from: user, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } })).status).toBe(200);
  expect(sim.last(7)!.message.text).toBe('Hi Ann! This bot runs on the edge.');
  expect((await webhook({ message: { message_id: 2, date: 1, chat, from: user, text: '/start' } }, 'wrong')).status).toBe(401);

  const menu = sim.last(7)!.message;
  const press = (data: string) => webhook({ callback_query: { id: String(updateId), from: user, chat_instance: '1', data, message: menu } });
  const buttons = menu.reply_markup!.inline_keyboard.flat();
  await press((buttons[1] as { callback_data: string }).callback_data);
  expect(sim.last(7)!.message.text).toBe("OK, I'll remind you in about a minute.");

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await worker.scheduled({}, env);
  } finally {
    Date.now = realNow;
  }
  expect(sim.last(7)!.message.text).toBe('⏰ One minute is up!');
});
