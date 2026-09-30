/**
 * `easytg preview`: your bot file, unchanged, against a simulated Telegram,
 * with a chat window in the browser. The bot runs in its own process and
 * restarts when a file changes; the chat stays.
 *
 * Needs Bun (it runs the bot with `bun --preload`).
 */
import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket, Subprocess } from 'bun';
import { TelegramSimulator, type SimChat, type SimMediaKind } from '../simulator';
import { generateTest, optionsCode, screenOf, type RecordedStep } from './testgen';

export interface PreviewOptions {
  /** Default 4545 (the next free one when taken). */
  port?: number;
  /** Open the browser. Default true. */
  open?: boolean;
  /** More users to switch between (Alice, Bob, …). Default 0. */
  users?: number;
  /** Add a group with every user. */
  group?: boolean;
  /** Restart the bot when a file in its folder changes. Default true. */
  watch?: boolean;
  /** Delay every API call, to see loading indicators. */
  latencyMs?: number;
  /** Where the bot's output goes. Default: this process's console. */
  log?: (line: string, stream: 'out' | 'err' | 'info') => void;
}

export interface Preview {
  url: string;
  sim: TelegramSimulator;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

type Status = 'starting' | 'running' | 'restarting' | 'stopped' | 'crashed';

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];
const here = dirname(fileURLToPath(import.meta.url));
/** src/ ships in the package, so the TypeScript sources are always there. */
const source = (name: string) => [resolve(here, `${name}.ts`), resolve(here, `../../src/preview/${name}.ts`)].find(existsSync)!;

export async function startPreview(file: string, options: PreviewOptions = {}): Promise<Preview> {
  const botFile = resolve(file);
  if (!existsSync(botFile)) throw new Error(`No such file: ${file}`);
  const root = process.cwd();
  const log = options.log ?? ((line, stream) => (stream === 'err' ? console.error(line) : console.log(line)));

  // Files the bot sends or users upload, served to the chat window.
  const files = new Map<string, Blob>();
  let nextFile = 1;
  const store = (data: Blob, name?: string) => {
    const id = String(nextFile++);
    files.set(id, data);
    return `/files/${id}/${encodeURIComponent(name ?? 'file')}`;
  };
  const sim = new TelegramSimulator({ storeFile: store, latencyMs: options.latencyMs, bot: { first_name: 'Your bot', username: 'preview_bot' } });
  for (let i = 0; i < (options.users ?? 0); i++) sim.addUser({ first_name: NAMES[i] ?? `User ${i + 2}` });
  if (options.group) sim.createGroup({ title: 'Test group', members: [...sim.users.keys()] });

  const built = await Bun.build({ entrypoints: [source('client')], target: 'browser', minify: true });
  if (!built.success) throw new AggregateError(built.logs, 'Could not build the preview page');
  const clientJs = await built.outputs[0]!.text();

  const sockets = new Set<ServerWebSocket<unknown>>();
  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) socket.send(text);
  };
  let status: Status = 'starting';
  let restarts = 0;
  const setStatus = (next: Status) => {
    status = next;
    broadcast({ type: 'status', status, restarts, file: relative(root, botFile) });
  };
  const logs: { stream: string; line: string }[] = [];
  const addLog = (line: string, stream: 'out' | 'err' | 'info') => {
    log(stream === 'info' ? line : line, stream);
    logs.push({ stream, line });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    broadcast({ type: 'log', stream, line });
  };

  // ---- the chat state, pushed to every window ----
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
  sim.on('call', (call) => broadcast({ type: 'call', call: { method: call.method, payload: summarize(call.payload), error: call.error, at: call.at } }));

  // ---- actions from the chat window, recorded for "Export test" ----
  let steps: RecordedStep[] = [];
  const record = (code: string, chat: number) => {
    // After the action, what the chat shows (updates are confirmed once handled).
    steps.push({ code, chat, screen: screenOf(sim, chat) });
  };
  const chatOf = (o: { user?: number; chat?: number } = {}) => o.chat ?? o.user ?? sim.user.id;
  const actions: Record<string, (...args: any[]) => Promise<unknown>> = {
    send: async (text: string, o = {}) => {
      const result = await sim.send(text, o);
      record(`await sim.send(${JSON.stringify(text)}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    press: async (messageId: number, button: { text: string }, o = {}) => {
      const result = await sim.press(messageId, button as never, o);
      record(`await sim.tap(${JSON.stringify(button.text)}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    pressReply: async (button: { text: string } | string, o = {}) => {
      const result = await sim.pressReply(button as never, o);
      const label = typeof button === 'string' ? button : button.text;
      record(`await sim.tap(${JSON.stringify(label)}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    sendMedia: async (kind: SimMediaKind, source: { upload?: string; name?: string; caption?: string }, o = {}) => {
      const data = source.upload ? files.get(source.upload) : undefined;
      const result = await sim.sendMedia(kind, { data, name: source.name, caption: source.caption }, o);
      record(`await sim.sendMedia(${JSON.stringify(kind)}, ${JSON.stringify({ name: source.name, data: undefined })}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    sendLocation: async (lat: number, lon: number, o = {}) => {
      const result = await sim.sendLocation(lat, lon, o);
      record(`await sim.sendLocation(${lat}, ${lon}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    sendContact: async (contact: undefined, o = {}) => {
      const result = await sim.sendContact(contact, o);
      record(`await sim.sendContact(undefined${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    sendWebAppData: async (data: string, button: string, o = {}) => {
      const result = await sim.sendWebAppData(data, button, o);
      record(`await sim.sendWebAppData(${JSON.stringify(data)}, ${JSON.stringify(button)}${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    inlineQuery: (query: string, o = {}) => sim.inlineQuery(query, o),
    chooseInlineResult: async (result: { id: string }, query: string, o = {}) => {
      const sent = await sim.chooseInlineResult(result as never, query, o);
      const user = o.user === undefined || o.user === sim.user.id ? '' : `, { user: ${o.user} }`;
      record(
        `await sim.chooseInlineResult((await sim.inlineQuery(${JSON.stringify(query)}${user})).find((r) => r.id === ${JSON.stringify(result.id)})!, ${JSON.stringify(query)}${optionsCode(sim, o.user, o.chat)})`,
        chatOf(o),
      );
      return sent;
    },
    pay: async (messageId: number, o = {}) => {
      const result = await sim.pay(messageId, o);
      record(`await sim.pay(sim.messages(${chatOf(o)}).findLast((m) => m.message.invoice)!.message.message_id${optionsCode(sim, o.user, o.chat)})`, chatOf(o));
      return result;
    },
    join: async (chatId: number, userId: number) => {
      const result = await sim.join(chatId, userId);
      record(`await sim.join(${chatId}, ${userId})`, chatId);
      return result;
    },
    clearHistory: async (chatId: number) => {
      sim.clearHistory(chatId);
      record(`sim.clearHistory(${chatId})`, chatId);
    },
    restart: () => restart(),
    reset: async () => {
      sim.reset();
      steps = [];
      await restart('🔄 Started over');
    },
    exportTest: async () => ({ code: generateTest(sim, steps, `./${relative(root, botFile)}`), steps: steps.length }),
  };

  // ---- the server: chat window, websocket, Bot API, files ----
  const html = PAGE.replaceAll('%FILE%', escapeHtml(relative(root, botFile)));
  const serve = (port: number) =>
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 60, // long polling holds requests for up to 30 s
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === '/ws') return server.upgrade(request) ? undefined : new Response('Expected a websocket', { status: 400 });
        if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/client.js') return new Response(clientJs, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
        if (url.pathname.startsWith('/files/')) {
          const data = files.get(url.pathname.split('/')[2]!);
          return data ? new Response(data) : new Response('Not Found', { status: 404 });
        }
        if (url.pathname === '/upload' && request.method === 'POST') {
          const id = store(await request.blob(), url.searchParams.get('name') ?? undefined).split('/')[2];
          return Response.json({ id });
        }
        if (url.pathname.startsWith('/bot') || url.pathname.startsWith('/file/bot')) return sim.handleRequest(request);
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          socket.send(JSON.stringify({ type: 'state', state: snapshot() }));
          socket.send(JSON.stringify({ type: 'status', status, restarts, file: relative(root, botFile) }));
          socket.send(JSON.stringify({ type: 'logs', logs }));
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
  for (let port = options.port ?? 4545; !server; port++) {
    try {
      server = serve(port);
    } catch (error) {
      if (options.port !== undefined || port > (options.port ?? 4545) + 20) throw error;
    }
  }
  const url = `http://127.0.0.1:${server.port}`;

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
    const proc = Bun.spawn([process.execPath, '--preload', source('register'), botFile], {
      cwd: root,
      env: {
        ...process.env,
        // Never the real token: nothing may reach Telegram from here.
        BOT_TOKEN: sim.token,
        EASYTG_PREVIEW_API: url,
        EASYTG_PREVIEW_ROOT: dirname(botFile),
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
      addLog(`[easytg preview] the bot exited (code ${code})`, 'info');
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
  const restart = async (note = '🔄 Restarted') => {
    setStatus('restarting');
    await kill();
    restarts++;
    if (sim.chats.size) sim.notice(note);
    addLog(`[easytg preview] ${note}`, 'info');
    spawn();
  };
  spawn();

  let watcher: FSWatcher | undefined;
  if (options.watch !== false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(dirname(botFile), { recursive: true }, (_event, name) => {
      if (!name || /(^|[/\\])(node_modules|\.git|dist)([/\\]|$)/.test(name) || !/\.(m?[jt]sx?|json)$/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void restart(`🔄 Restarted: ${name} changed`), 150);
    });
  }

  if (options.open !== false) {
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

/** Payloads for the API log: files become their names. */
function summarize(payload: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(payload, (_key, value) => (value instanceof Blob ? `[file ${(value as File).name ?? ''}]` : value)));
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easytg preview · %FILE%</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f6f8; --panel: #fff; --text: #0f1419; --muted: #6b7785; --border: rgba(0,0,0,.1); --accent: #2a9ef1; --bad: #e5484d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1016; --panel: #151c24; --text: #e8edf2; --muted: #8392a2; --border: rgba(255,255,255,.1); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  header b { font-size: 15px; }
  header code { color: var(--muted); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
  .dot.running { background: #30a46c; } .dot.crashed { background: var(--bad); } .dot.restarting, .dot.starting { background: #f5a524; }
  .spacer { flex: 1; }
  button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { flex: 1; display: grid; grid-template-columns: minmax(320px, 520px) minmax(0, 1fr); gap: 16px; padding: 16px; min-height: 0; }
  #chat { min-height: 0; }
  easytg-chat { --easytg-chat-height: 100%; height: 100%; }
  aside { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .tabs { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--border); }
  .tabs button { border: none; }
  .tabs button.on { background: var(--bg); font-weight: 600; }
  .pane { flex: 1; overflow: auto; padding: 8px 12px; font: 12px/1.45 ui-monospace, Menlo, monospace; }
  .pane div { padding: 3px 0; border-bottom: 1px dashed var(--border); white-space: pre-wrap; word-break: break-word; }
  .err { color: var(--bad); } .info { color: var(--muted); }
  .pane b { font-weight: 600; }
  textarea { width: 100%; height: 100%; min-height: 300px; font: 12px/1.45 ui-monospace, Menlo, monospace; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } aside { min-height: 300px; } #chat { height: 70vh; } }
</style>
</head>
<body>
<header>
  <b>easytg preview</b><code>%FILE%</code>
  <span id="status"><span class="dot"></span>connecting…</span>
  <span class="spacer"></span>
  <button id="restart" title="Restart the bot (keeps the chat)">Restart</button>
  <button id="reset" title="Clear the chats and restart the bot">Start over</button>
  <button id="export" class="primary" title="A bun test file that replays this conversation">Export test</button>
</header>
<main>
  <div id="chat"></div>
  <aside>
    <div class="tabs"><button data-tab="logs" class="on">Bot output</button><button data-tab="calls">API calls</button><button data-tab="test">Test</button></div>
    <div class="pane" id="logs"></div>
    <div class="pane" id="calls" hidden></div>
    <div class="pane" id="test" hidden><p>Use the chat, then press <b>Export test</b>: the conversation becomes a <code>bun test</code> file.</p></div>
  </aside>
</main>
<script type="module" src="/client.js"></script>
</body>
</html>`;
