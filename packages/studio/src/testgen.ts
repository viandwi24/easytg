/**
 * Turns what someone did in the studio into a `bun test` file: the same
 * messages and button presses, and what the chat showed after each. The test
 * runs the bot file as it is, with `loadBot` (JavaScript/TypeScript bots).
 */
import type { User } from 'grammy/types';
import type { SimChat, TelegramSimulator } from '@easytg/simulator';

export interface RecordedStep {
  /** Code for the action, e.g. `await sim.send('/start')`. */
  code: string;
  chat: number;
  /** What the chat showed afterwards. */
  screen?: Screen;
}

export interface Screen {
  text?: string;
  buttons?: string[];
}

/** The last message of a chat, as a test checks it. */
export function screenOf(sim: TelegramSimulator, chatId: number): Screen | undefined {
  const last = sim.messages(chatId).filter((m) => !m.notice).at(-1);
  if (!last) return undefined;
  const m = last.message;
  const buttons = m.reply_markup?.inline_keyboard?.flat().map((b) => b.text);
  return { text: m.text ?? m.caption ?? '', ...(buttons?.length ? { buttons } : {}) };
}

const js = (value: unknown) => JSON.stringify(value);

/** `, { user, chat }` for actions that aren't the first user in their private chat. */
export function optionsCode(sim: TelegramSimulator, user: number | undefined, chat: number | undefined, extra: Record<string, unknown> = {}): string {
  const options: Record<string, unknown> = { ...extra };
  const userId = user ?? sim.user.id;
  if (userId !== sim.user.id) options.user = userId;
  if (chat !== undefined && chat !== userId) options.chat = chat;
  const entries = Object.entries(options);
  return entries.length ? `, { ${entries.map(([k, v]) => `${k}: ${js(v)}`).join(', ')} }` : '';
}

export function generateTest(sim: TelegramSimulator, steps: RecordedStep[], botFile: string): string {
  const users = [...sim.users.values()];
  const [first, ...others] = users as [User, ...User[]];
  const groups = [...sim.chats.values()].filter((c): c is SimChat => c.type !== 'private');
  const people = (g: SimChat, status?: string) =>
    js([...g.members.values()].filter((m) => m.user.id !== sim.botInfo.id && (!status || m.status === status)).map((m) => m.user.id));
  const setup = [
    `const sim = new TelegramSimulator({ user: ${js(first)} });`,
    ...others.map((u) => `sim.addUser(${js(u)});`),
    ...groups.map((g) =>
      g.type === 'channel'
        ? `sim.createChannel({ id: ${g.id}, title: ${js(g.title ?? '')}, owner: ${js([...g.members.values()].find((m) => m.status === 'creator')?.user.id ?? first.id)}, subscribers: ${people(g, 'member')} });`
        : `sim.createGroup({ id: ${g.id}, title: ${js(g.title ?? '')}, type: ${js(g.type)}, members: ${people(g)}${g.forum ? ', forum: true' : ''} });`,
    ),
  ];
  const body = steps.flatMap((step) => {
    const lines = [`  ${step.code};`];
    if (step.screen) lines.push(`  expect(screen(${step.chat === sim.user.id ? '' : step.chat})).toEqual(${js(step.screen)});`);
    return lines;
  });
  return `/**
 * Recorded in easytg studio. Run it with \`bun test\` from the project folder
 * (it needs @easytg/simulator: \`bun add -d @easytg/simulator\`).
 * The bot file runs as it is, against a simulated Telegram.
 */
import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '@easytg/simulator';
import { loadBot } from '@easytg/simulator/load';

${setup.join('\n')}
const { stop } = await loadBot(${js(botFile)}, { simulator: sim });
afterAll(stop);

/** The last message of a chat: its text and inline buttons. */
function screen(chat = sim.user.id) {
  const m = sim.messages(chat).at(-1)?.message;
  const buttons = m?.reply_markup?.inline_keyboard?.flat().map((b) => b.text);
  return { text: m?.text ?? m?.caption ?? '', ...(buttons?.length ? { buttons } : {}) };
}

test('recorded conversation', async () => {
${body.join('\n')}
});
`;
}
