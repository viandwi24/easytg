<script setup lang="ts">
/**
 * A code editor next to a Telegram simulator. The code is a whole bot, the
 * same you would run with Node or Bun; edit it and press Run (⌘/Ctrl+Enter).
 */
import { useData, withBase } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EXAMPLES } from './examples';

const props = withDefaults(
  defineProps<{
    /** The bot's code, URI-encoded (from a ```ts playground fence). */
    code?: string;
    /** An example from examples/ by file name, instead of `code`. */
    example?: string;
    /** Show a picker with every example. */
    picker?: boolean;
    /** Sent as the user when the bot is ready ("" for nothing). */
    start?: string;
    /** Add a group with three members. */
    group?: boolean;
    /** Read-only teaser: the bot runs, and a click opens it in the playground. */
    preview?: boolean;
  }>(),
  { start: undefined, group: false, preview: false },
);

type Runner = typeof import('./runner');
type RunHandle = ReturnType<Runner['runBot']>;
type Tab = 'chat' | 'calls' | 'console';

const { isDark } = useData();
const host = ref<HTMLElement>();
const editorHost = ref<HTMLElement>();
const chatHost = ref<HTMLElement>();
const selected = ref(props.example ?? EXAMPLES[0]!.file);
const tab = ref<Tab>('chat');
const showCode = ref(true);
const running = ref(false);
const failed = ref(false);
const logs = ref<{ level: string; text: string }[]>([]);
const calls = ref<{ method: string; payload: string; error?: string; at: string }[]>([]);
const errorsSeen = computed(() => logs.value.filter((l) => l.level === 'error').length);

const example = computed(() => (props.code === undefined ? EXAMPLES.find((e) => e.file === selected.value) : undefined));
const initialCode = () => (props.code !== undefined ? decodeURIComponent(props.code) : (example.value?.code ?? ''));
const startText = computed(() => props.start ?? example.value?.start ?? '/start');
const playgroundLink = computed(() => withBase(`/playground?example=${selected.value}`));

function pick(file: string) {
  selected.value = file;
  try {
    history.replaceState(history.state, '', `?example=${file}`); // a link to this example
  } catch {
    // not in a browser window
  }
}

let runner: Runner | undefined;
let editor: import('@codemirror/view').EditorView | undefined;
let themeCompartment: import('@codemirror/state').Compartment | undefined;
let oneDark: import('@codemirror/state').Extension | undefined;
let current: RunHandle | undefined;
let chat: (HTMLElement & { simulator?: unknown }) | undefined;
let observer: IntersectionObserver | undefined;
const unsubscribe: (() => void)[] = [];
let generation = 0;

function format(value: unknown): string {
  if (value instanceof Error) {
    const inner = (value as { error?: unknown }).error;
    return inner instanceof Error ? `${inner.name}: ${inner.message}` : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

function log(level: string, args: unknown[]) {
  logs.value.push({ level, text: args.map(format).join(' ') });
  if (logs.value.length > 300) logs.value.splice(0, logs.value.length - 300);
}

async function run() {
  if (!runner || !chat) return;
  const id = ++generation;
  running.value = true;
  failed.value = false;
  unsubscribe.splice(0).forEach((off) => off());
  await current?.stop();
  if (id !== generation) return;
  logs.value = [];
  calls.value = [];
  const code = editor?.state.doc.toString() ?? initialCode();
  current = runner.runBot(code, { log, group: props.group || example.value?.group, users: example.value?.users });
  const sim = current.sim;
  unsubscribe.push(
    sim.on('call', (call) => {
      calls.value.push({
        method: call.method,
        payload: JSON.stringify(call.payload),
        error: call.error,
        at: new Date(call.at).toLocaleTimeString(),
      });
      if (calls.value.length > 200) calls.value.splice(0, calls.value.length - 200);
    }),
  );
  chat.removeAttribute('chat');
  chat.removeAttribute('user');
  chat.simulator = sim;
  try {
    await current.ready;
  } catch {
    failed.value = true;
    tab.value = 'console';
    running.value = false;
    return;
  }
  running.value = false;
  if (id === generation && startText.value) await sim.send(startText.value).catch((error: unknown) => log('error', [error]));
}

function reset() {
  if (!editor) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: initialCode() } });
  void run();
}

watch(selected, () => {
  if (!editor) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: initialCode() } });
  void run();
});

watch(isDark, (dark) => {
  chat?.setAttribute('theme', dark ? 'dark' : 'light');
  if (editor && themeCompartment) editor.dispatch({ effects: themeCompartment.reconfigure(dark && oneDark ? oneDark : []) });
});

onMounted(async () => {
  if (props.picker) {
    const wanted = new URLSearchParams(location.search).get('example');
    if (wanted && EXAMPLES.some((e) => e.file === wanted)) selected.value = wanted;
  }
  const [loaded, view, state, cm, js, dark] = await Promise.all([
    import('./runner'),
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('codemirror'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/theme-one-dark'),
    import('easytg/simulator/element'),
  ]);
  runner = loaded;
  oneDark = dark.oneDark;
  themeCompartment = new state.Compartment();
  editor = new view.EditorView({
    parent: editorHost.value!,
    doc: initialCode(),
    extensions: [
      cm.basicSetup,
      js.javascript({ typescript: true }),
      themeCompartment.of(isDark.value ? oneDark : []),
      ...(props.preview ? [state.EditorState.readOnly.of(true), view.EditorView.editable.of(false)] : []),
      view.keymap.of([{ key: 'Mod-Enter', run: () => (void run(), true) }]),
      view.EditorView.theme({ '&': { fontSize: '13px' }, '.cm-scroller': { fontFamily: 'var(--vp-font-family-mono)' } }),
    ],
  });
  chat = document.createElement('easytg-chat');
  chat.setAttribute('theme', isDark.value ? 'dark' : 'light');
  chatHost.value!.append(chat);
  // Start bots only when they scroll into view.
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer?.disconnect();
      void run();
    }
  });
  observer.observe(host.value!);
});

onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
  unsubscribe.forEach((off) => off());
  void current?.stop();
  editor?.destroy();
});
</script>

<template>
  <div ref="host" class="pg" :class="{ 'no-code': !showCode, preview }">
    <nav v-if="picker && code === undefined" class="examples" aria-label="Examples">
      <span class="examples-title">Examples</span>
      <button v-for="e in EXAMPLES" :key="e.file" class="chip" :class="{ on: e.file === selected }" @click="pick(e.file)">{{ e.title }}</button>
    </nav>
    <div class="bar">
      <span class="label">{{ code === undefined ? `examples/${selected}.ts` : '▶ Playground' }}</span>
      <span class="spacer" />
      <template v-if="!preview">
        <button class="btn" :title="showCode ? 'Hide the code' : 'Show the code'" @click="showCode = !showCode">{{ showCode ? 'Hide code' : 'Show code' }}</button>
        <button class="btn" title="Back to the original code" @click="reset">Reset</button>
        <button class="btn primary" title="Run (⌘/Ctrl + Enter)" :disabled="running" @click="run">{{ running ? 'Starting…' : 'Run' }}</button>
      </template>
      <a v-else class="btn primary" :href="playgroundLink">Open in the playground →</a>
    </div>
    <p v-if="example?.description && picker" class="about">{{ example.description }}</p>
    <div class="body">
      <div v-show="showCode" class="editor"><div ref="editorHost" class="editor-inner" /></div>
      <div class="side">
        <div v-show="!preview" class="tabs" role="tablist">
          <button :class="{ on: tab === 'chat' }" @click="tab = 'chat'">Chat</button>
          <button :class="{ on: tab === 'calls' }" @click="tab = 'calls'">API calls <small>{{ calls.length }}</small></button>
          <button :class="{ on: tab === 'console' }" @click="tab = 'console'">
            Console <small :class="{ bad: errorsSeen }">{{ errorsSeen ? `${errorsSeen} error${errorsSeen > 1 ? 's' : ''}` : logs.length }}</small>
          </button>
        </div>
        <div v-show="tab === 'chat'" ref="chatHost" class="chat" />
        <div v-show="tab === 'calls'" class="log">
          <div v-if="!calls.length" class="muted">No Bot API calls yet.</div>
          <div v-for="(c, i) in calls" :key="i" class="call" :class="{ bad: c.error }">
            <b>{{ c.method }}</b> <span class="muted">{{ c.at }}</span>
            <div v-if="c.error" class="err">{{ c.error }}</div>
            <code>{{ c.payload }}</code>
          </div>
        </div>
        <div v-show="tab === 'console'" class="log">
          <div v-if="!logs.length" class="muted">console.log output and errors appear here.</div>
          <pre v-for="(l, i) in logs" :key="i" :class="l.level">{{ l.text }}</pre>
        </div>
      </div>
      <a v-if="preview" class="overlay" :href="playgroundLink" aria-label="Open in the playground">
        <span class="cta">▶ Try it in the playground</span>
        <small>Edit the code, press the buttons, and switch between {{ EXAMPLES.length }} examples.</small>
      </a>
    </div>
  </div>
</template>

<style scoped>
.pg {
  container-type: inline-size;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  margin: 20px 0;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
}
.label {
  font-weight: 600;
  font-size: 14px;
  color: var(--vp-c-brand-1);
}
.spacer {
  flex: 1;
}
.btn {
  font-size: 13px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}
.btn:hover {
  border-color: var(--vp-c-brand-1);
}
.btn.primary {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-white);
}
.btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.about {
  margin: 0;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}
.body {
  display: grid;
  grid-template-columns: 1fr;
  position: relative;
}
.examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
}
.examples-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-text-3);
  margin-right: 4px;
}
.chip {
  font-size: 13px;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.chip.on {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-weight: 600;
}
.label {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}
a.btn {
  text-decoration: none;
  display: inline-block;
}
.overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 24px;
  text-decoration: none;
  background: linear-gradient(to bottom, transparent 35%, color-mix(in srgb, var(--vp-c-bg) 88%, transparent) 85%);
  transition: background 0.2s;
}
.overlay:hover {
  background: linear-gradient(to bottom, color-mix(in srgb, var(--vp-c-bg) 20%, transparent), color-mix(in srgb, var(--vp-c-bg) 92%, transparent) 80%);
}
.overlay .cta {
  font-size: 16px;
  font-weight: 600;
  color: var(--vp-c-white);
  background: var(--vp-c-brand-1);
  padding: 10px 22px;
  border-radius: 999px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.overlay small {
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.preview .chat {
  --easytg-chat-height: 440px;
}
@container (min-width: 820px) {
  .body {
    grid-template-columns: minmax(0, 1fr) 400px;
  }
  .no-code .body {
    grid-template-columns: 1fr;
  }
  /* The editor fills the row the chat sets, and scrolls inside. */
  .editor {
    position: relative;
    border-bottom: none !important;
    border-right: 1px solid var(--vp-c-divider);
  }
  .editor-inner {
    position: absolute;
    inset: 0;
  }
  .pg .editor :deep(.cm-editor) {
    height: 100%;
    max-height: none;
  }
}
.editor {
  min-width: 0;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}
.editor :deep(.cm-editor) {
  max-height: 380px;
}
.editor :deep(.cm-editor.cm-focused) {
  outline: none;
}
.side {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 8px;
  gap: 8px;
}
.tabs {
  display: flex;
  gap: 2px;
}
.tabs button {
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
}
.tabs button.on {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-weight: 600;
}
.tabs small {
  opacity: 0.7;
  font-weight: 400;
}
.tabs small.bad {
  color: var(--vp-c-danger-1);
  opacity: 1;
}
.chat {
  --easytg-chat-height: 520px;
}
.log {
  height: 520px;
  overflow: auto;
  font-size: 12.5px;
  background: var(--vp-c-bg);
  border-radius: 10px;
  padding: 8px 10px;
  border: 1px solid var(--vp-c-divider);
}
.log pre {
  margin: 0 0 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vp-font-family-mono);
}
.log pre.error {
  color: var(--vp-c-danger-1);
}
.log pre.warn {
  color: var(--vp-c-warning-1);
}
.call {
  padding: 4px 0;
  border-bottom: 1px dashed var(--vp-c-divider);
}
.call code {
  display: block;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vp-c-text-2);
  background: none;
  padding: 0;
}
.call .err {
  color: var(--vp-c-danger-1);
}
.muted {
  color: var(--vp-c-text-3);
}
</style>
