/**
 * easytg studio: a Telegram for development. Your bot runs in its own
 * process against a simulated Telegram (@easytg/simulator) and restarts when
 * a file changes; the studio page shows it like Telegram on a computer
 * (profiles, chat list, groups) next to its output and every Bot API call.
 *
 * - A JavaScript/TypeScript file runs unchanged with Bun: its calls to
 *   api.telegram.org are sent here.
 * - Any other command (Python, Go, …) gets `TELEGRAM_API_ROOT` and a fake
 *   `BOT_TOKEN`: point the bot's Bot API URL at it.
 *
 * Needs Bun.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket, Subprocess } from 'bun';
import { TelegramSimulator, type SimChat, type SimMediaKind } from '@easytg/simulator';
import { generateTest, optionsCode, screenOf, type RecordedStep } from './testgen';

export interface StudioOptions {
  /** A JavaScript/TypeScript bot file, run with Bun. */
  file?: string;
  /** Or any command that starts the bot (`python bot.py`). */
  command?: string;
  /** Default 4646 (the next free one when taken). */
  port?: number;
  /** Open the studio in the browser. Default false. */
  open?: boolean;
  /** Restart the bot when a file changes. Default true. */
  watch?: boolean;
  /** The folder watched for changes. Default: the bot file's folder, or the working directory. */
  watchDir?: string;
  /** More profiles to start with (Alice, Bob, …). Default 0. */
  users?: number;
  /** Start with a group of every profile. */
  group?: boolean;
  /** Delay every Bot API call: ms, or `[min, max]`. Default 120–280 ms, like a real network; 0 for none. */
  latencyMs?: number | [number, number];
  /** Where the bot's output goes besides the page. Default: this process's console. */
  log?: (line: string, stream: 'out' | 'err' | 'info') => void;
}

export interface Studio {
  url: string;
  sim: TelegramSimulator;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

type Status = 'starting' | 'running' | 'restarting' | 'stopped' | 'crashed';

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];
const here = dirname(fileURLToPath(import.meta.url));
/** Files that restart the bot when they change. */
const CODE = /\.(m?[jt]sx?|cjs|json|py|go|rb|php|rs|java|kts?|cs|exs?|lua|ya?ml|toml|env)$/;
const RESTARTED = '🔄 Restarted';
/** Tests don't run in the bot: changing them doesn't restart it. */
const TESTS = /(\.(test|spec)\.[^/\\]+|_test\.(go|py)|(^|[/\\])test_[^/\\]+\.py)$/;
const IGNORED = /(^|[/\\])(node_modules|\.git|dist|build|target|__pycache__|\.venv|venv|\.easytg-studio)([/\\]|$)/;

export async function startStudio(options: StudioOptions): Promise<Studio> {
  const root = process.cwd();
  const botFile = options.file ? resolve(options.file) : undefined;
  if (botFile && !existsSync(botFile)) throw new Error(`No such file: ${options.file}`);
  if (!botFile && !options.command) throw new Error('Give a bot file or a command');
  const target = botFile ? relative(root, botFile) : options.command!;
  const log = options.log ?? ((line, stream) => (stream === 'err' ? console.error(line) : console.log(line)));

  // Files the bot sends or users upload, served to the page.
  const files = new Map<string, Blob>();
  let nextFile = 1;
  const store = (data: Blob, name?: string) => {
    const id = String(nextFile++);
    files.set(id, data);
    return `/files/${id}/${encodeURIComponent(name ?? 'file')}`;
  };
  const sim = new TelegramSimulator({ storeFile: store, latencyMs: options.latencyMs ?? [120, 280], bot: { first_name: 'Your bot', username: 'studio_bot' } });
  for (let i = 0; i < (options.users ?? 0); i++) sim.addUser({ first_name: NAMES[i] ?? `User ${i + 2}` });

  /** Groups and channels made in the studio, made again after "Start over" (with their members). */
  type Made = { channel: false; options: Parameters<TelegramSimulator['createGroup']>[0] } | { channel: true; options: Parameters<TelegramSimulator['createChannel']>[0] };
  const made = new Map<number, Made>();
  const make = (entry: Made, id?: number) => {
    const chat = entry.channel ? sim.createChannel({ ...entry.options, id }) : sim.createGroup({ ...entry.options, id });
    made.set(chat.id, entry);
    return chat.id;
  };
  if (options.group) make({ channel: false, options: { title: 'Test group', members: [...sim.users.keys()] } });

  const built = await Bun.build({ entrypoints: [resolve(here, 'client.ts')], target: 'browser', minify: true });
  if (!built.success) throw new AggregateError(built.logs, 'Could not build the studio page');
  const clientJs = await built.outputs[0]!.text();

  const sockets = new Set<ServerWebSocket<unknown>>();
  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) socket.send(text);
  };
  let status: Status = 'starting';
  let restarts = 0;
  let url = '';
  const info = () => ({ type: 'status', status, restarts, target, kind: botFile ? 'file' : 'command', api: url, token: sim.token, bot: sim.botInfo });
  /** The bot's flow map (Mermaid), sent by its process when it is an easytg app. */
  let flow = '';
  const setStatus = (next: Status) => {
    status = next;
    broadcast(info());
  };
  const logs: { stream: string; line: string; at: number }[] = [];
  const addLog = (line: string, stream: 'out' | 'err' | 'info') => {
    log(line, stream);
    const entry = { stream, line, at: Date.now() };
    logs.push(entry);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    broadcast({ type: 'log', ...entry });
  };
  const calls: unknown[] = [];

  // ---- the simulator's state, pushed to every page ----
  const snapshot = () => ({
    botInfo: sim.botInfo,
    users: [...sim.users.values()],
    chats: [...sim.chats.values()].map((chat) => ({ ...chat, members: [...chat.members.entries()] })),
    commands: Object.fromEntries(
      [...sim.chats.values()].flatMap((chat: SimChat) => [...sim.users.keys()].map((user) => [`${chat.id}:${user}`, sim.commandsFor(chat.id, user)])),
    ),
    defaultCommands: Object.fromEntries([...sim.users.keys()].map((user) => [user, sim.commandsFor(user, user)])),
  });
  let pending = false;
  sim.on('change', () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      broadcast({ type: 'state', state: snapshot() });
    });
  });
  sim.on('toast', (data) => broadcast({ type: 'event', event: 'toast', data }));
  sim.on('open', (data) => broadcast({ type: 'event', event: 'open', data }));
  sim.on('call', (call) => {
    if (call.method === 'getUpdates' && !call.error && Array.isArray(call.result) && !call.result.length) return; // empty long polls
    const entry = { method: call.method, payload: summarize(call.payload), result: summarize(call.result), error: call.error, at: call.at };
    calls.push(entry);
    if (calls.length > 500) calls.splice(0, calls.length - 500);
    broadcast({ type: 'call', call: entry });
  });

  // ---- what the page can do; users' actions are recorded for "Export test" ----
  let steps: RecordedStep[] = [];
  const record = (code: string, chat: number) => {
    // After the action, what the chat shows (updates are confirmed once handled).
    steps.push({ code, chat, screen: screenOf(sim, chat) });
  };
  type Where = { user?: number; chat?: number; thread?: number };
  const chatOf = (o: Where = {}) => o.chat ?? o.user ?? sim.user.id;
  const where = (o: Where = {}) => optionsCode(sim, o.user, o.chat, o.thread === undefined ? {} : { thread: o.thread });
  const actions: Record<string, (...args: any[]) => unknown> = {
    send: async (text: string, o: Where = {}) => {
      const result = await sim.send(text, o);
      record(`await sim.send(${JSON.stringify(text)}${where(o)})`, chatOf(o));
      return result;
    },
    press: async (messageId: number, button: { text: string }, o: Where = {}) => {
      const result = await sim.press(messageId, button as never, o);
      record(`await sim.tap(${JSON.stringify(button.text)}${where(o)})`, chatOf(o));
      return result;
    },
    pressReply: async (button: { text: string } | string, o: Where = {}) => {
      const result = await sim.pressReply(button as never, o);
      record(`await sim.tap(${JSON.stringify(typeof button === 'string' ? button : button.text)}${where(o)})`, chatOf(o));
      return result;
    },
    sendMedia: async (kind: SimMediaKind, source: { upload?: string; name?: string; caption?: string }, o: Where = {}) => {
      const result = await sim.sendMedia(kind, { data: source.upload ? files.get(source.upload) : undefined, name: source.name, caption: source.caption }, o);
      record(`await sim.sendMedia(${JSON.stringify(kind)}, ${JSON.stringify({ name: source.name, caption: source.caption })}${where(o)})`, chatOf(o));
      return result;
    },
    sendLocation: async (lat: number, lon: number, o: Where = {}) => {
      const result = await sim.sendLocation(lat, lon, o);
      record(`await sim.sendLocation(${lat}, ${lon}${where(o)})`, chatOf(o));
      return result;
    },
    sendContact: async (contact: undefined, o: Where = {}) => {
      const result = await sim.sendContact(contact, o);
      record(`await sim.sendContact(undefined${where(o)})`, chatOf(o));
      return result;
    },
    sendWebAppData: async (data: string, button: string, o: Where = {}) => {
      const result = await sim.sendWebAppData(data, button, o);
      record(`await sim.sendWebAppData(${JSON.stringify(data)}, ${JSON.stringify(button)}${where(o)})`, chatOf(o));
      return result;
    },
    inlineQuery: (query: string, o = {}) => sim.inlineQuery(query, o),
    chooseInlineResult: async (result: { id: string }, query: string, o: Where = {}) => {
      const sent = await sim.chooseInlineResult(result as never, query, o);
      const user = o.user === undefined || o.user === sim.user.id ? '' : `, { user: ${o.user} }`;
      record(
        `await sim.chooseInlineResult((await sim.inlineQuery(${JSON.stringify(query)}${user})).find((r) => r.id === ${JSON.stringify(result.id)})!, ${JSON.stringify(query)}${where(o)})`,
        chatOf(o),
      );
      return sent;
    },
    pay: async (messageId: number, o: Where = {}) => {
      const result = await sim.pay(messageId, o);
      record(`await sim.pay(sim.messages(${chatOf(o)}).findLast((m) => m.message.invoice)!.message.message_id${where(o)})`, chatOf(o));
      return result;
    },
    clearHistory: (chatId: number) => {
      sim.clearHistory(chatId);
      record(`sim.clearHistory(${chatId})`, chatId);
    },
    stopGeneration: async (chatId: number) => {
      await sim.stopGeneration(chatId);
      record(`await sim.stopGeneration(${chatId})`, chatId);
    },
    exportTest: () => {
      if (!botFile) throw new Error('Export test is for JavaScript/TypeScript bot files (it runs them with loadBot)');
      return { code: generateTest(sim, steps, `./${relative(root, botFile)}`), steps: steps.length };
    },
    addUser: (profile?: { first_name?: string; last_name?: string; username?: string; language_code?: string }) =>
      sim.addUser({ ...profile, first_name: profile?.first_name || (NAMES[sim.users.size - 1] ?? `User ${sim.users.size + 1}`) }).id,
    createGroup: (o: Parameters<TelegramSimulator['createGroup']>[0]) => make({ channel: false, options: { ...o, title: o.title || 'New group' } }),
    createChannel: (o: Parameters<TelegramSimulator['createChannel']>[0]) => make({ channel: true, options: { ...o, title: o.title || 'New channel' } }),
    createTopic: async (chatId: number, name: string, o: { user?: number } = {}) => {
      const topic = await sim.createTopic(chatId, name, o);
      record(`await sim.createTopic(${chatId}, ${JSON.stringify(name)}${o.user !== undefined && o.user !== sim.user.id ? `, { user: ${o.user} }` : ''})`, chatId);
      return topic.id;
    },
    join: async (chatId: number, userId: number) => {
      await sim.join(chatId, userId);
      record(`await sim.join(${chatId}, ${userId})`, chatId);
      const entry = made.get(chatId);
      if (entry?.channel) entry.options.subscribers = [...(entry.options.subscribers ?? []), userId];
      else if (entry) entry.options.members = [...(entry.options.members ?? []), userId];
    },
    leave: async (chatId: number, userId: number) => {
      await sim.leave(chatId, userId);
      const entry = made.get(chatId);
      if (entry?.channel) entry.options.subscribers = entry.options.subscribers?.filter((id) => id !== userId);
      else if (entry) entry.options.members = entry.options.members?.filter((id) => id !== userId);
    },
    block: (userId: number, blocked: boolean) => sim.block(userId, blocked),
    setLatency: (ms: number | [number, number]) => {
      sim.latencyMs = Array.isArray(ms) ? [Math.max(0, ms[0]), Math.max(0, ms[1])] : Math.max(0, Number(ms) || 0);
    },
    restart: () => restart(),
    reset: async () => {
      sim.reset();
      const again = [...made];
      made.clear();
      for (const [id, entry] of again) make(entry, id);
      calls.length = 0;
      steps = [];
      broadcast({ type: 'calls', calls });
      await restart('🔄 Started over');
    },
  };

  // ---- the server: page, websocket, Bot API, files ----
  const html = PAGE.replaceAll('%TARGET%', escapeHtml(target));
  const serve = (port: number) =>
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 60, // long polling holds requests for up to 30 s
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === '/ws') return server.upgrade(request) ? undefined : new Response('Expected a websocket', { status: 400 });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (path === '/client.js') return new Response(clientJs, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
        if (path.startsWith('/files/')) {
          const data = files.get(path.split('/')[2]!);
          return data ? new Response(data) : new Response('Not Found', { status: 404 });
        }
        if (path === '/_studio/flow' && request.method === 'POST') {
          flow = await request.text();
          broadcast({ type: 'flow', chart: flow, url: mermaidLiveUrl(flow) });
          return new Response('ok');
        }
        if (path === '/upload' && request.method === 'POST') {
          const id = store(await request.blob(), new URL(request.url).searchParams.get('name') ?? undefined).split('/')[2];
          return Response.json({ id });
        }
        // The Bot API, for bots in any language: <url>/bot<token>/<method>.
        if (path.startsWith('/bot') || path.startsWith('/file/bot')) {
          // Like Telegram: a wrong token (often a real one left in the config) is refused.
          const token = path.replace(/^\/(file\/)?bot/, '').split('/')[0];
          if (decodeURIComponent(token ?? '') !== sim.token) {
            return Response.json({ ok: false, error_code: 401, description: `Unauthorized: the studio's token is ${sim.token} (BOT_TOKEN)` }, { status: 401 });
          }
          return sim.handleRequest(request);
        }
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          socket.send(JSON.stringify({ type: 'state', state: snapshot() }));
          socket.send(JSON.stringify(info()));
          socket.send(JSON.stringify({ type: 'logs', logs }));
          socket.send(JSON.stringify({ type: 'calls', calls }));
          if (flow) socket.send(JSON.stringify({ type: 'flow', chart: flow, url: mermaidLiveUrl(flow) }));
        },
        close(socket) {
          sockets.delete(socket);
        },
        async message(socket, raw) {
          const message = JSON.parse(String(raw)) as { id: number; method: string; args: unknown[] };
          const action = actions[message.method];
          try {
            if (!action) throw new Error(`Unknown action ${message.method}`);
            const value = await action(...(message.args ?? []));
            socket.send(JSON.stringify({ type: 'result', id: message.id, ok: true, value: value ?? null }));
          } catch (error) {
            socket.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        },
      },
    });
  let server: ReturnType<typeof serve> | undefined;
  for (let port = options.port ?? 4646; !server; port++) {
    try {
      server = serve(port);
    } catch (error) {
      if (options.port !== undefined || port > 4646 + 20) throw error;
    }
  }
  url = `http://127.0.0.1:${server.port}`;

  // ---- the bot's process ----
  let child: Subprocess | undefined;
  const pipe = async (stream: ReadableStream<Uint8Array> | undefined, kind: 'out' | 'err') => {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines) addLog(line, kind);
    }
    if (buffered) addLog(buffered, kind);
  };
  const spawn = () => {
    // `exec`: the shell becomes the bot, so stopping it stops the bot.
    const cmd = botFile
      ? [process.execPath, '--preload', resolve(here, 'register.ts'), botFile]
      : process.platform === 'win32'
        ? ['cmd', '/c', options.command!]
        : ['sh', '-c', `exec ${options.command}`];
    const proc = Bun.spawn(cmd, {
      cwd: root,
      env: {
        ...process.env,
        // Never the real token: nothing may reach Telegram from here.
        BOT_TOKEN: sim.token,
        TELEGRAM_BOT_TOKEN: sim.token,
        TELEGRAM_API_ROOT: url,
        EASYTG_STUDIO_API: url,
        EASYTG_STUDIO_ROOT: botFile ? dirname(botFile) : root,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child = proc;
    void pipe(proc.stdout as ReadableStream<Uint8Array>, 'out');
    void pipe(proc.stderr as ReadableStream<Uint8Array>, 'err');
    setStatus('running');
    void proc.exited.then((code) => {
      if (child !== proc) return; // replaced by a restart
      child = undefined;
      addLog(`[studio] the bot exited (code ${code})`, 'info');
      setStatus(code === 0 ? 'stopped' : 'crashed');
    });
  };
  const kill = async () => {
    const proc = child;
    child = undefined;
    if (!proc) return;
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(3000).then(() => proc.kill(9))]);
  };
  const restart = async (reason?: string) => {
    setStatus('restarting');
    await kill();
    restarts++;
    // The chat only says that the bot restarted (once, not once per restart in a row);
    // why it restarted goes to the output.
    for (const chat of sim.chats.values()) {
      if (chat.messages.at(-1)?.notice !== RESTARTED) sim.notice(RESTARTED, chat.id);
    }
    addLog(`[studio] restarted${reason ? `: ${reason}` : ''}`, 'info');
    spawn();
  };
  spawn();

  let watcher: FSWatcher | undefined;
  if (options.watch !== false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(resolve(options.watchDir ?? (botFile ? dirname(botFile) : root)), { recursive: true }, (_event, name) => {
      if (!name || IGNORED.test(name) || TESTS.test(name) || !CODE.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void restart(`${name} changed`), 150);
    });
  }

  if (options.open) {
    const opener = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', url] : ['xdg-open', url];
    try {
      Bun.spawn(opener, { stdout: 'ignore', stderr: 'ignore' });
    } catch {}
  }

  return {
    url,
    sim,
    restart: () => restart(),
    async stop() {
      watcher?.close();
      await kill();
      server!.stop(true);
    },
  };
}

/** Payloads and results for the API log: files become their names. */
function summarize(value: unknown) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, v) => (v instanceof Blob ? `[file ${(v as File).name ?? ''}]` : v)));
}

/** A link that opens a Mermaid diagram in Mermaid Live. */
function mermaidLiveUrl(diagram: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ code: diagram, mermaid: { theme: 'default' } }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `https://mermaid.live/edit#base64:${btoa(binary)}`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easytg studio · %TARGET%</title>
<style>
  :root { color-scheme: light dark; --bg: #eef1f4; --panel: #fff; --soft: #f6f8fa; --text: #0f1419; --muted: #6b7785; --border: rgba(0,0,0,.1); --accent: #2a9ef1; --bad: #e5484d; --good: #30a46c; --warn: #f5a524; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1016; --panel: #151c24; --soft: #1b232d; --text: #e8edf2; --muted: #8392a2; --border: rgba(255,255,255,.1); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  body { display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--border); min-height: 50px; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; white-space: nowrap; }
  .brand i { width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg, #72d5fd, #2a9ef1); display: inline-block; }
  .brand small { font-weight: 500; color: var(--muted); }
  .target { font: 12.5px ui-monospace, Menlo, monospace; color: var(--muted); background: var(--soft); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 40vw; }
  #status { display: flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.running { background: var(--good); } .dot.crashed, .dot.disconnected { background: var(--bad); } .dot.restarting, .dot.starting { background: var(--warn); }
  .spacer { flex: 1; }
  button, select, input { font: inherit; font-size: 13px; color: var(--text); }
  button { padding: 5px 12px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel); cursor: pointer; white-space: nowrap; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.on { background: var(--soft); border-color: var(--accent); }
  main { flex: 1; display: flex; min-height: 0; gap: 0; }
  #chat { flex: 1; min-width: 0; padding: 12px; }
  easytg-chat { --easytg-chat-height: 100%; height: 100%; }
  aside { width: 420px; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-left: 1px solid var(--border); }
  body.no-panel aside { display: none; }
  body.command .file-only { display: none; }
  textarea.code { width: 100%; min-height: 320px; font: 12px/1.45 ui-monospace, Menlo, monospace; background: var(--soft); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
  pre.chart { font: 12px/1.45 ui-monospace, Menlo, monospace; background: var(--soft); border: 1px solid var(--border); border-radius: 6px; padding: 8px; overflow: auto; white-space: pre; }
  .tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid var(--border); }
  .tabs button { border: none; background: none; }
  .tabs button.on { background: var(--soft); font-weight: 600; }
  .tabs small { color: var(--muted); font-weight: 400; }
  .tabs small.bad { color: var(--bad); }
  .pane { flex: 1; overflow: auto; min-height: 0; }
  .pane[hidden] { display: none; }
  .tools { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); align-items: center; position: sticky; top: 0; background: var(--panel); }
  .tools input[type=search] { flex: 1; min-width: 0; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--soft); }
  .line { padding: 2px 10px; font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .line.err { color: var(--bad); } .line.info { color: var(--muted); }
  .call { border-bottom: 1px solid var(--border); }
  .call summary { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; list-style: none; }
  .call summary::-webkit-details-marker { display: none; }
  .call summary:hover { background: var(--soft); }
  .call b { font: 600 12.5px ui-monospace, Menlo, monospace; }
  .call .t { margin-left: auto; color: var(--muted); font-size: 11.5px; }
  .call .e { color: var(--bad); font-size: 12px; }
  .call.bad b { color: var(--bad); }
  .call pre { margin: 0; padding: 6px 10px 10px; font: 11.5px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; background: var(--soft); }
  .call h6 { margin: 0; padding: 6px 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--soft); }
  .section { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .section h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .row .grow { flex: 1; min-width: 0; }
  .row small { color: var(--muted); }
  .av { width: 28px; height: 28px; border-radius: 50%; color: #fff; display: grid; place-items: center; font-weight: 600; font-size: 12px; flex: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--soft); border: 1px solid var(--border); }
  .chip button { border: none; background: none; padding: 0 0 0 4px; color: var(--muted); }
  label.check { display: inline-flex; gap: 4px; align-items: center; font-size: 13px; margin: 2px 8px 2px 0; }
  input[type=text], input[type=number], select { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--soft); }
  code.copy { display: block; font: 12px ui-monospace, Menlo, monospace; background: var(--soft); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; word-break: break-all; cursor: copy; margin: 4px 0 8px; }
  pre.snippet { font: 12px/1.45 ui-monospace, Menlo, monospace; background: var(--soft); border: 1px solid var(--border); border-radius: 6px; padding: 8px; overflow: auto; margin: 4px 0 10px; }
  p.hint { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
  .empty { padding: 20px; color: var(--muted); text-align: center; font-size: 13px; }
  @media (max-width: 900px) {
    main { flex-direction: column; }
    #chat { height: 75vh; flex: none; padding: 8px; }
    aside { width: auto; border-left: none; border-top: 1px solid var(--border); min-height: 360px; }
    .target { display: none; }
  }
</style>
</head>
<body>
<div class="top">
  <span class="brand"><i></i>easytg <small>studio</small></span>
  <span class="target" title="%TARGET%">%TARGET%</span>
  <span id="status"><span class="dot"></span>connecting…</span>
  <span class="spacer"></span>
  <button id="restart" title="Restart the bot; the chats stay (also when a file changes)">Restart</button>
  <button id="reset" title="Clear every chat and restart the bot (profiles and groups stay)">Start over</button>
  <button id="toggle" class="on" title="Show or hide the panel">Panel</button>
</div>
<main>
  <div id="chat"></div>
  <aside>
    <div class="tabs">
      <button data-tab="output" class="on">Output <small id="n-output"></small></button>
      <button data-tab="calls">API calls <small id="n-calls"></small></button>
      <button data-tab="world">World</button>
      <button data-tab="flow" hidden>Flow</button>
      <button data-tab="test" class="file-only">Test</button>
      <button data-tab="connect">Connect</button>
    </div>
    <div class="pane" id="output"><div class="tools"><input type="search" placeholder="Filter output" id="f-output"><button id="clear-output">Clear</button></div><div id="lines"></div></div>
    <div class="pane" id="calls" hidden><div class="tools"><input type="search" placeholder="Filter by method or text" id="f-calls"><label class="check"><input type="checkbox" id="only-errors">Errors</label><button id="clear-calls">Clear</button></div><div id="call-list"></div></div>
    <div class="pane" id="world" hidden></div>
    <div class="pane" id="flow" hidden></div>
    <div class="pane" id="test" hidden><div class="section"><h4>Export test</h4><p class="hint">Use the chat, then export: the conversation becomes a <code>bun test</code> file that runs the bot file as it is and checks what each step shows.</p><p><button id="export" class="primary">Export test</button></p><div id="test-out"></div></div></div>
    <div class="pane" id="connect" hidden></div>
  </aside>
</main>
<script type="module" src="/client.js"></script>
</body>
</html>`;
