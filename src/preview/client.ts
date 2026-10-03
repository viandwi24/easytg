/// <reference lib="dom" />
/**
 * The page of `easytg preview`: the chat window on a simulator that lives in
 * the preview server. State comes over a websocket; actions go back.
 */
import type { BotCommand, User, UserFromGetMe } from 'grammy/types';
import { mountChat } from '../simulator/element';
import type { SimChat, SimMessage, TelegramSimulator } from '../simulator';

type Listener = (event: any) => void;

interface State {
  botInfo: UserFromGetMe;
  users: User[];
  chats: (Omit<SimChat, 'members'> & { members: [number, SimChat['members'] extends Map<number, infer M> ? M : never][] })[];
  commands: Record<string, BotCommand[]>;
  defaultCommands: Record<string, BotCommand[]>;
}

/** What the chat window needs from a simulator, backed by the server's. */
class RemoteSimulator {
  botInfo = { id: 0, is_bot: true, first_name: 'Bot', username: 'bot' } as UserFromGetMe;
  users = new Map<number, User>();
  chats = new Map<number, SimChat>();
  private commandMap: Record<string, BotCommand[]> = {};
  private defaultCommands: Record<string, BotCommand[]> = {};
  private readonly listeners = new Map<string, Set<Listener>>();
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly onMessage: (message: any) => void) {
    this.connect();
  }

  private connect() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'state') this.apply(message.state);
      else if (message.type === 'event') this.emit(message.event, message.data);
      else if (message.type === 'result') {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) waiting?.resolve(message.value);
        else waiting?.reject(new Error(message.error));
      }
      this.onMessage(message);
    };
    socket.onclose = () => {
      this.onMessage({ type: 'status', status: 'disconnected' });
      for (const waiting of this.pending.values()) waiting.reject(new Error('Disconnected from easytg preview'));
      this.pending.clear();
      setTimeout(() => this.connect(), 1000);
    };
  }

  private apply(state: State) {
    this.botInfo = state.botInfo;
    this.users = new Map(state.users.map((u) => [u.id, u]));
    this.chats = new Map(state.chats.map((c) => [c.id, { ...c, members: new Map(c.members) } as SimChat]));
    this.commandMap = state.commands;
    this.defaultCommands = state.defaultCommands;
    this.emit('change', {});
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket?.send(JSON.stringify({ id, method, args }));
    });
  }

  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(event: string, data: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

  get user(): User {
    return this.users.values().next().value!;
  }

  chat(id: number) {
    return this.chats.get(id);
  }

  messages(chatId = this.user.id): SimMessage[] {
    return this.chats.get(chatId)?.messages ?? [];
  }

  last(chatId = this.user.id) {
    return this.messages(chatId).at(-1);
  }

  commandsFor(chatId = this.user.id, userId = this.user.id): BotCommand[] {
    return this.commandMap[`${chatId}:${userId}`] ?? (chatId === userId ? this.defaultCommands[userId] : undefined) ?? [];
  }

  clearHistory(chatId = this.user.id) {
    void this.call('clearHistory', chatId);
  }

  send = (...args: unknown[]) => this.call('send', ...args);
  press = (...args: unknown[]) => this.call('press', ...args);
  pressReply = (...args: unknown[]) => this.call('pressReply', ...args);
  sendLocation = (...args: unknown[]) => this.call('sendLocation', ...args);
  sendContact = (...args: unknown[]) => this.call('sendContact', ...args);
  sendWebAppData = (...args: unknown[]) => this.call('sendWebAppData', ...args);
  inlineQuery = (...args: unknown[]) => this.call('inlineQuery', ...args);
  chooseInlineResult = (...args: unknown[]) => this.call('chooseInlineResult', ...args);
  join = (...args: unknown[]) => this.call('join', ...args);
  stopGeneration = (...args: unknown[]) => this.call('stopGeneration', ...args);

  /** Files picked in the browser are uploaded first: the server keeps them. */
  async sendMedia(kind: string, source: { url?: string; name?: string; caption?: string }, options: unknown) {
    let upload: string | undefined;
    if (source.url?.startsWith('blob:')) {
      const blob = await (await fetch(source.url)).blob();
      const response = await fetch(`/upload?name=${encodeURIComponent(source.name ?? 'file')}`, { method: 'POST', body: blob });
      upload = ((await response.json()) as { id: string }).id;
    }
    return this.call('sendMedia', kind, { upload, name: source.name, caption: source.caption }, options);
  }
}

// ---- the page ----

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const logs = $('#logs');
const calls = $('#calls');
const status = $('#status');

const addLine = (pane: HTMLElement, html: string, className = '') => {
  const stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = html;
  pane.append(div);
  while (pane.children.length > 500) pane.firstElementChild!.remove();
  if (stick) pane.scrollTop = pane.scrollHeight;
};
const esc = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const sim = new RemoteSimulator((message) => {
  if (message.type === 'status') {
    const label = { running: 'running', starting: 'starting…', restarting: 'restarting…', stopped: 'stopped', crashed: 'crashed: see the output', disconnected: 'disconnected, reconnecting…' }[message.status as string] ?? message.status;
    status.innerHTML = `<span class="dot ${esc(message.status)}"></span>${esc(label)}`;
  } else if (message.type === 'logs') {
    logs.innerHTML = '';
    for (const entry of message.logs) addLine(logs, esc(entry.line), entry.stream);
  } else if (message.type === 'log') {
    addLine(logs, esc(message.line), message.stream);
  } else if (message.type === 'flow') {
    const pane = $('#flow');
    pane.innerHTML = `<p><button id="copy-flow">Copy</button> <a href="${esc(message.url)}" target="_blank" rel="noopener"><button>Open in Mermaid Live</button></a> <span class="info">Paste it into GitHub Markdown in a \`\`\`mermaid block.</span></p><pre></pre>`;
    pane.querySelector('pre')!.textContent = message.chart;
    (pane.querySelector('#copy-flow') as HTMLButtonElement).onclick = () => void navigator.clipboard.writeText(message.chart);
  } else if (message.type === 'call') {
    const { method, payload, error, at } = message.call;
    addLine(calls, `<b>${esc(method)}</b> <span class="info">${new Date(at).toLocaleTimeString()}</span>${error ? `<br><span class="err">${esc(error)}</span>` : ''}<br><span class="info">${esc(JSON.stringify(payload))}</span>`);
  }
});

mountChat($('#chat'), sim as unknown as TelegramSimulator, { theme: 'auto' });

// "Two chats": a second window, as another user (added when there is none).
let second: HTMLElement | undefined;
$('#split').onclick = async () => {
  const main = document.querySelector('main')!;
  const on = !main.classList.contains('split');
  main.classList.toggle('split', on);
  $('#split').textContent = on ? 'One chat' : 'Two chats';
  if (!on || second) return;
  const other = [...sim.users.keys()][1] ?? (await sim.call<number>('addUser'));
  second = mountChat($('#chat2'), sim as unknown as TelegramSimulator, { theme: 'auto', user: other, chat: other });
};

// Tabs.
for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('.tabs button')) other.classList.toggle('on', other === tab);
    for (const pane of document.querySelectorAll<HTMLElement>('.pane')) pane.hidden = pane.id !== tab.dataset.tab;
  };
}
const showTab = (name: string) => document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${name}"]`)!.click();

$('#restart').onclick = () => void sim.call('restart');
$('#reset').onclick = () => {
  if (confirm('Clear every chat and restart the bot?')) void sim.call('reset');
};
$('#export').onclick = async () => {
  const { code, steps } = await sim.call<{ code: string; steps: number }>('exportTest');
  const pane = $('#test');
  pane.innerHTML = `<p>${steps ? `${steps} recorded step${steps === 1 ? '' : 's'}.` : 'Nothing recorded yet: use the chat first.'} Save it as e.g. <code>bot.test.ts</code> and run <code>bun test</code>.</p>
    <p><button id="copy">Copy</button> <button id="download">Download</button></p><textarea readonly></textarea>`;
  pane.querySelector('textarea')!.value = code;
  (pane.querySelector('#copy') as HTMLButtonElement).onclick = () => void navigator.clipboard.writeText(code);
  (pane.querySelector('#download') as HTMLButtonElement).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([code], { type: 'text/typescript' }));
    a.download = 'bot.test.ts';
    a.click();
  };
  showTab('test');
};
