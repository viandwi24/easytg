/// <reference lib="dom" />
/**
 * The studio page: the chat window on the simulator that lives in the studio
 * server (state comes over a websocket, actions go back), plus the panel:
 * the bot's output, every Bot API call, the simulated world (profiles,
 * groups) and how to connect a bot in any language.
 */
import type { BotCommand, User, UserFromGetMe } from 'grammy/types';
import { mountChat } from '@easytg/simulator/element';
import type { SimChat, SimMessage, TelegramSimulator } from '@easytg/simulator';

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
      for (const waiting of this.pending.values()) waiting.reject(new Error('Disconnected from the studio'));
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

  /** Not served by the studio: the page shows files by their URL. */
  fileUrl(): string | undefined {
    return undefined;
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
  pay = (...args: unknown[]) => this.call('pay', ...args);
  join = (...args: unknown[]) => this.call('join', ...args);
  stopGeneration = (...args: unknown[]) => this.call('stopGeneration', ...args);
  addUser = (user?: Partial<User>) => this.call<number>('addUser', user);
  createGroup = (options: object) => this.call<number>('createGroup', options);
  createChannel = (options: object) => this.call<number>('createChannel', options);
  createTopic = (chatId: number, name: string, options?: object) => this.call<number>('createTopic', chatId, name, options);

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

// ---- helpers ----

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COLORS = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];
const av = (id: number, name: string) => `<span class="av" style="background:${COLORS[Math.abs(id) % COLORS.length]}">${esc([...name.trim()][0]?.toUpperCase() ?? '?')}</span>`;
const fullName = (u: { first_name: string; last_name?: string }) => [u.first_name, u.last_name].filter(Boolean).join(' ');
const html = new WeakMap<Element, string>();
/** Sets innerHTML only when it changed, so inputs and open <details> keep their state. */
const patch = (element: HTMLElement, value: string) => {
  if (html.get(element) === value) return;
  element.innerHTML = value;
  html.set(element, value);
};
const stickToEnd = (pane: HTMLElement) => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
const copy = (text: string) => void navigator.clipboard?.writeText(text);

// ---- status, output and API calls ----

let info: { status: string; target: string; kind: 'file' | 'command'; api: string; token: string } | undefined;
const outputPane = $('#output');
const lines = $('#lines');
const callsPane = $('#calls');
const callList = $('#call-list');
let errorsInOutput = 0;
let callCount = 0;
let callErrors = 0;

function counts() {
  $('#n-output').textContent = errorsInOutput ? `${errorsInOutput} err` : '';
  $('#n-output').className = errorsInOutput ? 'bad' : '';
  $('#n-calls').textContent = callErrors ? `${callCount} · ${callErrors} err` : callCount ? String(callCount) : '';
  $('#n-calls').className = callErrors ? 'bad' : '';
}

function matches(element: HTMLElement, filter: string) {
  return !filter || (element.textContent ?? '').toLowerCase().includes(filter);
}

function addLine(entry: { stream: string; line: string }) {
  const stick = stickToEnd(outputPane);
  const div = document.createElement('div');
  div.className = `line ${entry.stream}`;
  div.textContent = entry.line;
  div.hidden = !matches(div, $<HTMLInputElement>('#f-output').value.toLowerCase());
  lines.append(div);
  if (entry.stream === 'err') errorsInOutput++;
  while (lines.children.length > 1000) lines.firstElementChild!.remove();
  if (stick) outputPane.scrollTop = outputPane.scrollHeight;
  counts();
}

function addCall(call: { method: string; payload?: unknown; result?: unknown; error?: string; at: number }) {
  const stick = stickToEnd(callsPane);
  const details = document.createElement('details');
  details.className = `call${call.error ? ' bad' : ''}`;
  details.dataset.error = call.error ? '1' : '';
  const json = (value: unknown) => esc(JSON.stringify(value, null, 2));
  details.innerHTML = `<summary><b>${esc(call.method)}</b>${call.error ? `<span class="e">${esc(call.error)}</span>` : ''}<span class="t">${new Date(call.at).toLocaleTimeString()}</span></summary>
    <h6>Request</h6><pre>${json(call.payload ?? {})}</pre>${call.result !== undefined ? `<h6>Result</h6><pre>${json(call.result)}</pre>` : ''}`;
  filterCall(details);
  callList.append(details);
  callCount++;
  if (call.error) callErrors++;
  while (callList.children.length > 500) callList.firstElementChild!.remove();
  if (stick) callsPane.scrollTop = callsPane.scrollHeight;
  counts();
}

function filterCall(details: HTMLElement) {
  const filter = $<HTMLInputElement>('#f-calls').value.toLowerCase();
  const onlyErrors = $<HTMLInputElement>('#only-errors').checked;
  details.hidden = (onlyErrors && !details.dataset.error) || !matches(details, filter);
}

$('#f-output').oninput = () => {
  const filter = $<HTMLInputElement>('#f-output').value.toLowerCase();
  for (const line of lines.children as HTMLCollectionOf<HTMLElement>) line.hidden = !matches(line, filter);
};
$('#f-calls').oninput = $('#only-errors').onchange = () => {
  for (const call of callList.children as HTMLCollectionOf<HTMLElement>) filterCall(call);
};
$('#clear-output').onclick = () => {
  lines.innerHTML = '';
  errorsInOutput = 0;
  counts();
};
$('#clear-calls').onclick = () => {
  callList.innerHTML = '';
  callCount = callErrors = 0;
  counts();
};

const sim = new RemoteSimulator((message) => {
  if (message.type === 'status') {
    if (message.status !== 'disconnected') {
      info = message;
      document.body.classList.toggle('command', message.kind === 'command');
    }
    const label =
      { running: 'running', starting: 'starting…', restarting: 'restarting…', stopped: 'stopped', crashed: 'crashed: see Output', disconnected: 'studio stopped, reconnecting…' }[
        message.status as string
      ] ?? message.status;
    $('#status').innerHTML = `<span class="dot ${esc(message.status)}"></span>${esc(label)}${message.restarts ? ` <small style="color:var(--muted)">· ${message.restarts} restart${message.restarts > 1 ? 's' : ''}</small>` : ''}`;
    renderConnect();
  } else if (message.type === 'logs') {
    lines.innerHTML = '';
    errorsInOutput = 0;
    for (const entry of message.logs) addLine(entry);
  } else if (message.type === 'log') {
    addLine(message);
  } else if (message.type === 'calls') {
    callList.innerHTML = '';
    callCount = callErrors = 0;
    for (const call of message.calls) addCall(call);
    counts();
  } else if (message.type === 'call') {
    addCall(message.call);
  } else if (message.type === 'state') {
    renderWorld();
  } else if (message.type === 'flow') {
    // An easytg bot: its flow map (pages, dialogues and the buttons pressed so far).
    $('[data-tab="flow"]').hidden = false;
    const pane = $('#flow');
    pane.innerHTML = `<div class="section"><h4>Flow map</h4><p class="hint">Pages, dialogues and commands, and the buttons pressed so far. Paste it into Markdown in a <code>\`\`\`mermaid</code> block.</p>
      <p><button id="copy-flow">Copy</button> <a href="${esc(message.url)}" target="_blank" rel="noopener"><button>Open in Mermaid Live</button></a></p><pre class="chart"></pre></div>`;
    pane.querySelector('pre')!.textContent = message.chart;
    $('#copy-flow').onclick = () => copy(message.chart);
  }
});

mountChat($('#chat'), sim as unknown as TelegramSimulator, { theme: 'auto' });

// ---- tabs and toolbar ----

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('.tabs button')) other.classList.toggle('on', other === tab);
    for (const pane of document.querySelectorAll<HTMLElement>('.pane')) pane.hidden = pane.id !== tab.dataset.tab;
  };
}
$('#restart').onclick = () => void sim.call('restart');
$('#reset').onclick = () => {
  if (confirm('Clear every chat and restart the bot? Profiles and groups stay.')) void sim.call('reset');
};
$('#toggle').onclick = () => {
  const hidden = document.body.classList.toggle('no-panel');
  $('#toggle').classList.toggle('on', !hidden);
  try {
    localStorage.setItem('easytg-studio-panel', hidden ? 'hidden' : 'shown');
  } catch {}
};
try {
  if (localStorage.getItem('easytg-studio-panel') === 'hidden') $('#toggle').click();
} catch {}

// ---- World: profiles, groups, latency ----

const world = $('#world');
world.innerHTML = `
  <div class="section" id="w-bot"></div>
  <div class="section"><h4>Profiles</h4><div id="w-profiles"></div>
    <div class="row" style="margin-top:6px"><input type="text" id="p-name" placeholder="First name" class="grow"><input type="text" id="p-username" placeholder="username" style="width:110px"><input type="text" id="p-lang" placeholder="en" style="width:48px"><button id="p-add">Add</button></div>
  </div>
  <div class="section"><h4>Groups and channels</h4><div id="w-groups"></div>
    <div style="margin-top:8px"><div class="row"><select id="g-kind"><option value="supergroup">Supergroup</option><option value="group">Group</option><option value="forum">Group with topics</option><option value="channel">Channel</option></select><input type="text" id="g-title" placeholder="Title" class="grow"><button id="g-add">Create</button></div><div id="g-members" class="chips"></div>
    <p class="hint">Or with ✎ above the chat list. The first ticked profile creates (owns) it.</p></div>
  </div>
  <div class="section"><h4>Network</h4>
    <div class="row"><span class="grow">Delay every Bot API call</span><select id="latency"><option value="0">None</option><option value="120,280" selected>Normal (120–280 ms)</option><option value="600,1200">Slow (0.6–1.2 s)</option><option value="2000,3500">Very slow (2–3.5 s)</option></select></div>
    <p class="hint">Like a real network: pressed buttons show a spinner and edits arrive a moment later. "None" for instant answers.</p>
  </div>`;

function renderWorld() {
  const bot = sim.botInfo;
  patch($('#w-bot'), `<h4>Bot</h4><div class="row">${av(bot.id, bot.first_name)}<div class="grow"><b>${esc(bot.first_name)}</b> <small>@${esc(bot.username)} · id ${bot.id}</small></div></div>`);
  const users = [...sim.users.values()];
  patch(
    $('#w-profiles'),
    users
      .map((u) => {
        const chat = sim.chats.get(u.id);
        const state = chat?.blocked ? 'blocked the bot' : chat?.started ? 'started the bot' : 'not started';
        return `<div class="row">${av(u.id, u.first_name)}<div class="grow">${esc(fullName(u))} <small>${u.username ? `@${esc(u.username)} · ` : ''}id ${u.id}${u.language_code ? ` · ${esc(u.language_code)}` : ''} · ${state}</small></div>
          ${chat?.started ? `<button data-block="${u.id}" data-blocked="${chat.blocked ? '' : '1'}">${chat.blocked ? 'Unblock' : 'Block'}</button>` : ''}</div>`;
      })
      .join(''),
  );
  const groups = [...sim.chats.values()].filter((c) => c.type !== 'private');
  const kindOf = (c: SimChat) => (c.type === 'channel' ? 'channel' : c.forum ? 'forum, ' + ((c.topics?.length ?? 0) + 1) + ' topics' : c.type);
  patch(
    $('#w-groups'),
    groups.length
      ? groups
          .map((g) => {
            const members = [...g.members.values()].filter((m) => !m.user.is_bot && m.status !== 'left' && m.status !== 'kicked');
            const outside = users.filter((u) => !members.some((m) => m.user.id === u.id));
            return `<div style="margin-bottom:10px"><div class="row">${av(g.id, g.title ?? 'G')}<div class="grow"><b>${esc(g.title)}</b> <small>${kindOf(g)} · ${members.length} ${g.type === 'channel' ? 'subscriber' : 'member'}${members.length === 1 ? '' : 's'} · id ${g.id}</small></div></div>
              <div class="chips">${members.map((m) => `<span class="chip">${esc(m.user.first_name)}${m.status === 'creator' ? ' 👑' : m.status === 'administrator' ? ' ⭐' : ''}<button title="Leave the group" data-leave="${g.id}:${m.user.id}">×</button></span>`).join('')}
              ${outside.length ? `<select data-join="${g.id}"><option value="">+ Add member</option>${outside.map((u) => `<option value="${u.id}">${esc(u.first_name)}</option>`).join('')}</select>` : ''}</div></div>`;
          })
          .join('')
      : '<p class="hint">None yet. Members join groups with a "joined the group" message, like on Telegram; channels quietly.</p>',
  );
  patch($('#g-members'), users.map((u, i) => `<label class="check"><input type="checkbox" value="${u.id}"${i === 0 ? ' checked' : ''}>${esc(u.first_name)}</label>`).join(''));
}

world.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const leave = target.dataset.leave;
  if (leave) {
    const [chat, user] = leave.split(':').map(Number);
    void sim.call('leave', chat, user);
  }
  if (target.dataset.block) void sim.call('block', Number(target.dataset.block), target.dataset.blocked === '1');
});
world.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.dataset.join && target.value) void sim.call('join', Number(target.dataset.join), Number(target.value));
});
$('#p-add').onclick = async () => {
  const name = $<HTMLInputElement>('#p-name');
  if (!name.value.trim()) return name.focus();
  const username = $<HTMLInputElement>('#p-username').value.trim().replace(/^@/, '');
  const lang = $<HTMLInputElement>('#p-lang').value.trim();
  await sim.call('addUser', { first_name: name.value.trim(), ...(username && { username }), ...(lang && { language_code: lang }) });
  name.value = $<HTMLInputElement>('#p-username').value = $<HTMLInputElement>('#p-lang').value = '';
};
$('#p-name').onkeydown = (event) => {
  if (event.key === 'Enter') $('#p-add').click();
};
$('#g-add').onclick = async () => {
  const members = [...document.querySelectorAll<HTMLInputElement>('#g-members input:checked')].map((input) => Number(input.value));
  const kind = $<HTMLSelectElement>('#g-kind').value;
  const title = $<HTMLInputElement>('#g-title').value.trim();
  if (kind === 'channel') await sim.createChannel({ title, owner: members[0], subscribers: members.slice(1) });
  else await sim.createGroup({ title, members: members.length ? members : undefined, type: kind === 'group' ? 'group' : 'supergroup', forum: kind === 'forum' });
  $<HTMLInputElement>('#g-title').value = '';
};
$('#latency').onchange = () => {
  const value = $<HTMLSelectElement>('#latency').value.split(',').map(Number);
  void sim.call('setLatency', value.length === 2 ? value : value[0]);
};

// ---- Connect: bots in any language ----

function renderConnect() {
  if (!info) return;
  const { api, token, kind } = info;
  const how =
    kind === 'file'
      ? `<p class="hint">This JavaScript/TypeScript file runs with Bun, and its calls to api.telegram.org come here: nothing to change. Bots in other languages connect like this:</p>`
      : `<p class="hint">The command gets these environment variables. Point the bot's Bot API URL at <code>TELEGRAM_API_ROOT</code> and use <code>BOT_TOKEN</code>:</p>`;
  patch(
    $('#connect'),
    `<div class="section"><h4>Bot API</h4>${how}
      <div class="hint">TELEGRAM_API_ROOT</div><code class="copy" data-copy="${esc(api)}">${esc(api)}</code>
      <div class="hint">BOT_TOKEN (also TELEGRAM_BOT_TOKEN), never a real one</div><code class="copy" data-copy="${esc(token)}">${esc(token)}</code>
      <div class="hint">Try it</div><code class="copy" data-copy="curl ${esc(api)}/bot${esc(token)}/getMe">curl ${esc(api)}/bot${esc(token)}/getMe</code>
      <p class="hint">Long polling (<code>getUpdates</code>) works; webhooks don't: the studio can't call your server.</p></div>
    <div class="section"><h4>grammY</h4><pre class="snippet">new Bot(process.env.BOT_TOKEN!, {
  client: { apiRoot: process.env.TELEGRAM_API_ROOT },
});</pre>
    <h4>Telegraf</h4><pre class="snippet">new Telegraf(process.env.BOT_TOKEN!, {
  telegram: { apiRoot: process.env.TELEGRAM_API_ROOT },
});</pre>
    <h4>python-telegram-bot</h4><pre class="snippet">root = os.environ["TELEGRAM_API_ROOT"]
app = (Application.builder().token(os.environ["BOT_TOKEN"])
       .base_url(f"{root}/bot").base_file_url(f"{root}/file/bot").build())</pre>
    <h4>aiogram</h4><pre class="snippet">session = AiohttpSession(api=TelegramAPIServer.from_base(os.environ["TELEGRAM_API_ROOT"]))
bot = Bot(os.environ["BOT_TOKEN"], session=session)</pre>
    <h4>Run it</h4><pre class="snippet">easytg-studio --cmd "python bot.py"</pre></div>`,
  );
}
$('#connect').addEventListener('click', (event) => {
  const value = (event.target as HTMLElement).dataset.copy;
  if (value) copy(value);
});

// ---- Test: the conversation so far as a bun test ----

$('#export').onclick = async () => {
  const out = $('#test-out');
  try {
    const { code, steps } = await sim.call<{ code: string; steps: number }>('exportTest');
    out.innerHTML = `<p class="hint">${steps ? `${steps} recorded step${steps === 1 ? '' : 's'}.` : 'Nothing recorded yet: use the chat first.'} Save it as e.g. <code>bot.test.ts</code> and run <code>bun test</code>.</p>
      <p><button id="copy-test">Copy</button> <button id="download-test">Download</button></p><textarea class="code" readonly></textarea>`;
    out.querySelector('textarea')!.value = code;
    $('#copy-test').onclick = () => copy(code);
    $('#download-test').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([code], { type: 'text/typescript' }));
      a.download = 'bot.test.ts';
      a.click();
    };
  } catch (error) {
    out.innerHTML = `<p class="hint">${esc((error as Error).message)}</p>`;
  }
};
