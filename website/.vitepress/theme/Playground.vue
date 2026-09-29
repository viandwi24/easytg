<script setup lang="ts">
/**
 * A code editor next to a Telegram simulator. The code is a whole bot, the
 * same you would run with Node or Bun; edit it and press Run (⌘/Ctrl+Enter).
 */
import { useData } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
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
  }>(),
  { start: undefined, group: false },
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
  current = runner.runBot(code, { log, group: props.group || example.value?.group });
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
  <div ref="host" class="pg" :class="{ 'no-code': !showCode }">
    <div class="bar">
      <select v-if="picker && code === undefined" v-model="selected" class="pick" aria-label="Example">
        <option v-for="e in EXAMPLES" :key="e.file" :value="e.file">{{ e.title }}</option>
      </select>
      <span v-else class="label">▶ Playground</span>
      <span class="spacer" />
      <button class="btn" :title="showCode ? 'Hide the code' : 'Show the code'" @click="showCode = !showCode">{{ showCode ? 'Hide code' : 'Show code' }}</button>
      <button class="btn" title="Back to the original code" @click="reset">Reset</button>
      <button class="btn primary" title="Run (⌘/Ctrl + Enter)" :disabled="running" @click="run">{{ running ? 'Starting…' : 'Run' }}</button>
    </div>
    <p v-if="example?.description && picker" class="about">{{ example.description }}</p>
    <div class="body">
      <div v-show="showCode" ref="editorHost" class="editor" />
      <div class="side">
        <div class="tabs" role="tablist">
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
.pick {
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  padding: 4px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  max-width: 100%;
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
}
@container (min-width: 820px) {
  .body {
    grid-template-columns: minmax(0, 1fr) 400px;
  }
  .no-code .body {
    grid-template-columns: 1fr;
  }
  .editor {
    border-bottom: none !important;
    border-right: 1px solid var(--vp-c-divider);
  }
  .editor :deep(.cm-editor) {
    height: 100%;
    max-height: 640px;
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
