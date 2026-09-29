/** The runnable files from examples/ that work in the browser playground. */
const sources = import.meta.glob('../../../examples/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface Example {
  file: string;
  title: string;
  description: string;
  /** What the user sends first. */
  start?: string;
  /** Needs a group chat. */
  group?: boolean;
  /** Needs more users (switch between them at the top of the chat). */
  users?: boolean;
}

const LIST: Example[] = [
  { file: 'match', title: 'Match (swipe)', description: 'Profile cards with ❤️ 💌 👎 💤 reactions, like the dating bots on Telegram. Make a profile, then switch to Alice (top of the chat) to like each other and match.', users: true },
  { file: 'getting-started', title: 'Getting started', description: 'Pages, typed navigation, a dialogue, sessions and a main menu (docs/getting-started.md).' },
  { file: 'shop', title: 'Shop', description: 'A reply-keyboard menu, pagination, Back, photos and albums, and a checkout asking for size, contact and location.' },
  { file: 'search', title: 'Search, 2 languages', description: 'page.onText, i18n messages with plurals and a language picker.' },
  { file: 'media', title: 'Media', description: 'Photos, videos, GIFs, documents, audio and albums, switched in place.' },
  { file: 'loading', title: 'Loading', description: 'Placeholders, "typing…" and toasts for slow pages and dialogues.' },
  { file: 'payments', title: 'Payments', description: 'Invoices, a pre-checkout check and a receipt. Paying here is simulated.' },
  { file: 'inline', title: 'Inline mode', description: 'Type "@demo_bot tea" in the message field to share pages into a chat.', start: '' },
  { file: 'sessions', title: 'Sessions', description: 'Per-chat, per-user and chat-wide state. Switch between the private chat and the group at the top of the chat.', group: true },
  { file: 'group', title: 'Group bot', description: 'Admin-only settings, a live scoreboard and a quiz. Pick the group (and who is typing) at the top of the chat.', group: true, start: '' },
  { file: 'queue', title: 'Queues', description: 'Slow jobs behind a queue, with the place in line.' },
  { file: 'captcha', title: 'Captcha', description: 'A button captcha and a typed captcha.' },
  { file: 'broadcast', title: 'Broadcast', description: 'Subscribe, then /broadcast as the admin (you are the admin here).' },
];

export const EXAMPLES = LIST.filter((e) => sources[`../../../examples/${e.file}.ts`] !== undefined).map((e) => ({
  ...e,
  code: sources[`../../../examples/${e.file}.ts`]!,
}));
