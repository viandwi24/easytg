/// <reference lib="dom" />
/**
 * `<easytg-chat>`: a Telegram-like chat window for a TelegramSimulator.
 * Messages, inline and reply keyboards, toasts and alerts, media, invoices,
 * inline mode, the command menu and attachments, in light and dark.
 *
 *   import { TelegramSimulator } from 'easytg/simulator';
 *   import { mountChat } from 'easytg/simulator/element';
 *
 *   mountChat(document.querySelector('#chat')!, sim);
 *
 * or `<easytg-chat theme="dark">` with `element.simulator = sim`.
 * Attributes: `chat` (chat id; default the user's private chat), `user`
 * (who types; default the first user), `theme` (`light`, `dark`, `auto`).
 */
import type { InlineKeyboardButton, InlineQueryResult, KeyboardButton, Message, MessageEntity } from 'grammy/types';
import type { SimChat, SimMessage, TelegramSimulator } from './index';

const STYLE = /* css */ `
:host {
  --tg-bg: #dfe6ea;
  --tg-panel: #ffffff;
  --tg-in: #ffffff;
  --tg-out: #e2fbd6;
  --tg-text: #0f1419;
  --tg-muted: #6f7f8b;
  --tg-out-muted: #4fa84a;
  --tg-accent: #3390ec;
  --tg-button: rgba(255, 255, 255, 0.82);
  --tg-button-text: #1f6fbf;
  --tg-button-hover: #ffffff;
  --tg-border: rgba(0, 0, 0, 0.08);
  --tg-code: rgba(0, 0, 0, 0.06);
  --tg-quote: rgba(51, 144, 236, 0.1);
  --tg-service: rgba(0, 0, 0, 0.28);
  --tg-shadow: 0 1px 2px rgba(16, 35, 47, 0.15);
  display: block;
  height: var(--easytg-chat-height, 540px);
  font: 15px/1.38 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--tg-text);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--tg-border);
  contain: content;
}
:host([data-dark]) {
  --tg-bg: #0e1621;
  --tg-panel: #17212b;
  --tg-in: #182533;
  --tg-out: #2b5278;
  --tg-text: #f5f5f5;
  --tg-muted: #7d8b99;
  --tg-out-muted: #7da8d3;
  --tg-accent: #6ab3f3;
  --tg-button: rgba(255, 255, 255, 0.1);
  --tg-button-text: #ffffff;
  --tg-button-hover: rgba(255, 255, 255, 0.18);
  --tg-border: rgba(255, 255, 255, 0.08);
  --tg-code: rgba(255, 255, 255, 0.08);
  --tg-quote: rgba(106, 179, 243, 0.12);
  --tg-service: rgba(0, 0, 0, 0.35);
  --tg-shadow: none;
}
* { box-sizing: border-box; }
.root { display: flex; flex-direction: column; height: 100%; background: var(--tg-bg); position: relative; }
header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--tg-panel); border-bottom: 1px solid var(--tg-border); min-height: 54px; }
.avatar { width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg, #72d5fd, #2a9ef1); color: #fff; display: grid; place-items: center; font-weight: 600; flex: none; }
.who { flex: 1; min-width: 0; }
.name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { font-size: 13px; color: var(--tg-muted); }
.status.active { color: var(--tg-accent); }
header select { font: inherit; font-size: 13px; background: transparent; color: var(--tg-text); border: 1px solid var(--tg-border); border-radius: 6px; padding: 3px 4px; max-width: 130px; }
header select option { background: var(--tg-panel); }
.list { flex: 1; overflow-y: auto; padding: 10px 10px 6px; display: flex; flex-direction: column; gap: 4px; scrollbar-width: thin; }
.empty { margin: auto; text-align: center; color: var(--tg-muted); font-size: 14px; padding: 20px; }
.empty b { display: block; color: var(--tg-text); margin-bottom: 4px; }
.row { display: flex; flex-direction: column; align-items: flex-start; max-width: min(85%, 460px); }
.row.out { align-self: flex-end; align-items: flex-end; }
.bubble { background: var(--tg-in); border-radius: 14px 14px 14px 4px; padding: 6px 10px 6px; box-shadow: var(--tg-shadow); max-width: 100%; overflow-wrap: anywhere; position: relative; }
.out .bubble { background: var(--tg-out); border-radius: 14px 14px 4px 14px; }
.bubble.media { padding: 3px; }
.bubble.media .text, .bubble.media .meta, .bubble.media .quote, .bubble.media .sender { margin-left: 7px; margin-right: 7px; }
.sender { font-size: 13px; font-weight: 600; color: var(--tg-accent); }
.text { white-space: pre-wrap; }
.meta { float: right; font-size: 11.5px; color: var(--tg-muted); margin: 6px 0 -4px 10px; line-height: 1.6; user-select: none; }
.out .meta { color: var(--tg-out-muted); }
.via { font-size: 13px; color: var(--tg-accent); font-weight: 500; }
.quote { border-left: 3px solid var(--tg-accent); background: var(--tg-quote); border-radius: 4px; padding: 2px 8px; margin: 2px 0 4px; font-size: 13.5px; }
.quote b { color: var(--tg-accent); display: block; font-size: 13px; }
.quote span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; opacity: 0.85; }
a { color: var(--tg-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.cmd { color: var(--tg-accent); cursor: pointer; }
code, pre { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 13.5px; }
code { background: var(--tg-code); border-radius: 4px; padding: 0 3px; }
pre { background: var(--tg-code); border-radius: 6px; padding: 6px 8px; margin: 4px 0; white-space: pre-wrap; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 4px 0; border-left: 3px solid var(--tg-accent); background: var(--tg-quote); padding: 2px 8px; border-radius: 4px; }
.spoiler { background: var(--tg-muted); color: transparent; border-radius: 4px; cursor: pointer; transition: all .2s; }
.spoiler.shown { background: transparent; color: inherit; cursor: auto; }
.img { display: block; width: 100%; max-width: 360px; max-height: 360px; object-fit: cover; border-radius: 11px; }
.album { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px; max-width: 360px; }
.album .img, .album .ph { border-radius: 6px; height: 140px; aspect-ratio: auto; }
.ph { width: 260px; max-width: 100%; aspect-ratio: 4 / 3; border-radius: 11px; display: grid; place-items: center; background: linear-gradient(135deg, rgba(51,144,236,.25), rgba(114,213,253,.25)); color: var(--tg-muted); font-size: 13px; text-align: center; padding: 8px; }
.ph span { font-size: 34px; display: block; }
.file { display: flex; align-items: center; gap: 10px; padding: 6px 7px 2px; min-width: 200px; }
.file .icon { width: 42px; height: 42px; border-radius: 50%; background: var(--tg-accent); color: #fff; display: grid; place-items: center; font-size: 20px; flex: none; }
.file small { display: block; color: var(--tg-muted); font-size: 12.5px; }
.card { padding: 4px 2px; min-width: 220px; }
.card .title { font-weight: 600; }
.card .amount { font-size: 20px; font-weight: 600; margin-top: 4px; }
.dice { font-size: 56px; line-height: 1.1; }
.keyboard { display: flex; flex-direction: column; gap: 3px; margin-top: 3px; width: 100%; min-width: 220px; }
.krow { display: flex; gap: 3px; }
.kbtn { flex: 1 1 0; min-width: 0; font: inherit; font-size: 14px; font-weight: 500; color: var(--tg-button-text); background: var(--tg-button); border: none; border-radius: 8px; padding: 7px 8px; cursor: pointer; position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: var(--tg-shadow); backdrop-filter: blur(8px); transition: background .12s; }
.kbtn:hover { background: var(--tg-button-hover); }
.kbtn .corner { position: absolute; top: 2px; right: 5px; font-size: 10px; opacity: .8; }
.kbtn.busy::after { content: ''; position: absolute; top: 5px; right: 6px; width: 9px; height: 9px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.service { align-self: center; background: var(--tg-service); color: #fff; font-size: 13px; padding: 3px 10px; border-radius: 12px; margin: 4px 0; max-width: 85%; text-align: center; }
.banner { background: #e5484d; color: #fff; font-size: 13px; padding: 6px 10px; display: flex; gap: 8px; align-items: flex-start; }
.banner pre { background: none; margin: 0; padding: 0; color: inherit; flex: 1; font-size: 12px; max-height: 80px; overflow: auto; }
.banner button { background: none; border: none; color: #fff; cursor: pointer; font-size: 16px; }
.dock { background: var(--tg-panel); border-top: 1px solid var(--tg-border); }
.panel { max-height: 210px; overflow-y: auto; border-bottom: 1px solid var(--tg-border); }
.panel .item { display: flex; gap: 10px; align-items: center; padding: 7px 12px; cursor: pointer; }
.panel .item:hover { background: var(--tg-code); }
.panel .item b { color: var(--tg-accent); font-weight: 500; }
.panel .item small { color: var(--tg-muted); display: block; font-size: 12.5px; }
.panel .item img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; }
.panel .hint { padding: 8px 12px; color: var(--tg-muted); font-size: 13px; }
.reply { display: flex; flex-direction: column; gap: 5px; padding: 6px; background: var(--tg-bg); max-height: 220px; overflow-y: auto; }
.reply .krow { gap: 5px; }
.reply .kbtn { background: var(--tg-panel); color: var(--tg-text); padding: 10px 8px; }
.input { display: flex; align-items: center; gap: 4px; padding: 6px 8px; }
.input input { flex: 1; min-width: 0; font: inherit; border: none; outline: none; background: transparent; color: var(--tg-text); padding: 8px 6px; }
.input input::placeholder { color: var(--tg-muted); }
.icon-btn { background: none; border: none; color: var(--tg-muted); font-size: 20px; width: 38px; height: 38px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; flex: none; font-family: inherit; }
.icon-btn:hover { background: var(--tg-code); color: var(--tg-accent); }
.icon-btn.send { color: var(--tg-accent); }
.icon-btn.menu { background: var(--tg-accent); color: #fff; font-size: 13px; font-weight: 600; width: auto; height: 32px; border-radius: 16px; padding: 0 10px; }
.icon-btn.menu:hover { filter: brightness(1.08); color: #fff; }
.toast { position: absolute; left: 50%; top: 70px; transform: translateX(-50%); background: rgba(0, 0, 0, 0.78); color: #fff; font-size: 14px; padding: 9px 14px; border-radius: 10px; max-width: 80%; text-align: center; pointer-events: none; animation: fade 2.2s forwards; z-index: 3; white-space: pre-wrap; }
@keyframes fade { 0% { opacity: 0; } 8% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: 0; } }
.modal { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); display: grid; place-items: center; z-index: 4; padding: 16px; }
.dialog { background: var(--tg-panel); border-radius: 12px; padding: 16px 18px 10px; width: min(320px, 100%); box-shadow: 0 8px 30px rgba(0,0,0,.3); }
.dialog p { margin: 0 0 12px; white-space: pre-wrap; }
.dialog .title { font-weight: 600; margin-bottom: 6px; }
.dialog textarea { width: 100%; min-height: 70px; font: 13px ui-monospace, Menlo, monospace; background: var(--tg-bg); color: var(--tg-text); border: 1px solid var(--tg-border); border-radius: 6px; padding: 6px; margin-bottom: 8px; }
.dialog .actions { display: flex; justify-content: flex-end; gap: 4px; }
.dialog .actions button { font: inherit; font-weight: 600; color: var(--tg-accent); background: none; border: none; padding: 8px 10px; border-radius: 6px; cursor: pointer; text-transform: uppercase; font-size: 13.5px; }
.dialog .actions button:hover { background: var(--tg-code); }
.dialog code { word-break: break-all; }
`;

type Modal =
  | { kind: 'alert'; text: string }
  | { kind: 'webApp'; url: string; button?: string }
  | { kind: 'attach' };

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (date: number) => new Date(date * 1000).toTimeString().slice(0, 5);
const MEDIA_ICON: Record<string, string> = { photo: '🖼', video: '🎬', animation: '🎞', audio: '🎵', document: '📄', voice: '🎤', sticker: '💟', video_note: '⏺' };

export class EasyTGChatElement extends HTMLElement {
  static observedAttributes = ['chat', 'user', 'theme'];

  private sim?: TelegramSimulator;
  private unsubscribe: (() => void)[] = [];
  private readonly root: ShadowRoot;
  private frame = 0;
  private busy = new Set<string>();
  private revealed = new Set<string>();
  private errors: string[] = [];
  private modal: Modal | null = null;
  private panel: 'commands' | 'inline' | null = null;
  private inlineResults: { query: string; results: InlineQueryResult[] } | null = null;
  private inlineTimer?: ReturnType<typeof setTimeout>;
  private draft = '';
  private dark?: MediaQueryList;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.addEventListener('click', (event) => this.onClick(event as MouseEvent));
    this.root.addEventListener('keydown', (event) => this.onKey(event as KeyboardEvent));
    this.root.addEventListener('input', (event) => this.onInput(event));
    this.root.addEventListener('change', (event) => this.onChange(event));
  }

  /** The simulator to show. */
  get simulator(): TelegramSimulator | undefined {
    return this.sim;
  }

  set simulator(sim: TelegramSimulator | undefined) {
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
    this.sim = sim;
    this.errors = [];
    if (sim) {
      this.unsubscribe.push(
        sim.on('change', () => this.schedule()),
        sim.on('toast', (toast) => {
          if (toast.chatId !== undefined && toast.chatId !== this.chatId) return;
          if (toast.alert) this.modal = { kind: 'alert', text: toast.text };
          else this.toast(toast.text);
          this.schedule();
        }),
        sim.on('open', (event) => {
          if (event.kind === 'webApp') {
            this.modal = { kind: 'webApp', url: event.url };
            this.schedule();
          } else globalThis.open?.(event.url, '_blank', 'noopener');
        }),
        sim.on('error', ({ error }) => {
          const e = error as { error?: unknown; message?: string };
          const inner = (e?.error ?? error) as { message?: string };
          this.errors.push(inner?.message ?? String(inner));
          console.error(error);
          this.schedule();
        }),
      );
    }
    this.schedule();
  }

  /** The chat shown. */
  get chatId(): number {
    const attr = this.getAttribute('chat');
    return attr ? Number(attr) : this.userId;
  }

  set chatId(id: number) {
    this.setAttribute('chat', String(id));
  }

  /** The user typing. */
  get userId(): number {
    const attr = this.getAttribute('user');
    return attr ? Number(attr) : (this.sim?.user.id ?? 0);
  }

  set userId(id: number) {
    this.setAttribute('user', String(id));
  }

  connectedCallback() {
    this.dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    this.dark?.addEventListener('change', this.onScheme);
    this.onScheme();
    this.schedule();
  }

  disconnectedCallback() {
    this.dark?.removeEventListener('change', this.onScheme);
    cancelAnimationFrame(this.frame);
  }

  attributeChangedCallback() {
    this.onScheme();
    this.schedule();
  }

  private onScheme = () => {
    const theme = this.getAttribute('theme') ?? 'auto';
    this.toggleAttribute('data-dark', theme === 'dark' || (theme === 'auto' && !!this.dark?.matches));
  };

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /* ------------------------------ rendering ------------------------------ */

  private shell?: { header: HTMLElement; banners: HTMLElement; list: HTMLElement; dock: HTMLElement; modal: HTMLElement };
  private readonly html = new WeakMap<Element, string>();

  /** Built once; afterwards only the parts that changed are replaced (images and videos keep playing). */
  private ensureShell() {
    if (this.shell) return this.shell;
    this.root.innerHTML = `<style>${STYLE}</style><div class="root"><header></header><div class="banners"></div><div class="list"></div><div class="dock-slot"></div><div class="modal-slot"></div></div>`;
    const q = (selector: string) => this.root.querySelector(selector) as HTMLElement;
    this.shell = { header: q('header'), banners: q('.banners'), list: q('.list'), dock: q('.dock-slot'), modal: q('.modal-slot') };
    return this.shell;
  }

  /** Sets innerHTML when it changed; returns whether it did. */
  private patch(element: HTMLElement, html: string): boolean {
    if (this.html.get(element) === html) return false;
    element.innerHTML = html;
    this.html.set(element, html);
    return true;
  }

  private render() {
    const sim = this.sim;
    const shell = this.ensureShell();
    const list = shell.list;
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const focused = (this.root.activeElement as HTMLElement | null)?.dataset?.focus;

    if (!sim) {
      this.patch(shell.header, '');
      this.patch(shell.dock, '');
      this.reconcile(list, [{ key: 'none', html: '<div class="empty">No simulator connected</div>' }]);
      return;
    }
    const chat = sim.chat(this.chatId);
    const title = chat?.type === 'private' || !chat ? sim.botInfo.first_name : (chat.title ?? 'Group');
    const status = chat?.action ? `${chat.action.action.replace(/_/g, ' ').replace('upload ', 'sending ')}…` : chat && chat.type !== 'private' ? `${[...chat.members.values()].filter((m) => !['left', 'kicked'].includes(m.status)).length} members` : 'bot';

    this.patch(
      shell.header,
      `<div class="avatar">${esc([...title][0] ?? '?')}</div>
      <div class="who"><div class="name">${esc(title)}</div><div class="status${chat?.action ? ' active' : ''}">${esc(status)}</div></div>
      ${this.switchers()}`,
    );
    this.patch(shell.banners, this.errors.map((e, i) => `<div class="banner"><span>⚠️</span><pre>${esc(e)}</pre><button data-act="dismiss" data-i="${i}" title="Dismiss">×</button></div>`).join(''));
    this.reconcile(list, chat?.messages.length ? this.messages(chat) : [{ key: 'empty', html: this.empty() }]);
    if (this.patch(shell.dock, this.dock(chat))) {
      const input = shell.dock.querySelector('input[data-focus="text"]') as HTMLInputElement | null;
      if (input) {
        input.value = this.draft;
        if (focused === 'text') {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
    }
    if (this.patch(shell.modal, this.modal ? this.renderModal(this.modal) : '') && focused === 'webapp') {
      (shell.modal.querySelector('[data-focus="webapp"]') as HTMLElement | null)?.focus();
    }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  /** Keyed update of the message list: unchanged messages keep their DOM. */
  private reconcile(list: HTMLElement, items: { key: string; html: string }[]) {
    const existing = new Map<string, HTMLElement>();
    for (const child of [...list.children] as HTMLElement[]) existing.set(child.dataset.key ?? '', child);
    let previous: Element | null = null;
    for (const item of items) {
      let element = existing.get(item.key);
      if (!element || this.html.get(element) !== item.html) {
        const template = document.createElement('template');
        template.innerHTML = item.html;
        const fresh = template.content.firstElementChild as HTMLElement;
        fresh.dataset.key = item.key;
        this.html.set(fresh, item.html);
        element?.replaceWith(fresh);
        element = fresh;
      }
      existing.delete(item.key);
      const expected: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
      if (expected !== element) list.insertBefore(element, expected);
      previous = element;
    }
    existing.forEach((element) => element.remove());
  }

  private switchers() {
    const sim = this.sim!;
    const chats = [...sim.chats.values()].filter((c) => c.type !== 'private' || c.started || c.id === this.chatId);
    const users = [...sim.users.values()];
    const chatSelect =
      chats.length > 1
        ? `<select data-act="chat" title="Chat">${chats.map((c) => `<option value="${c.id}"${c.id === this.chatId ? ' selected' : ''}>${esc(c.type === 'private' ? `💬 ${c.user?.first_name}` : `👥 ${c.title}`)}</option>`).join('')}</select>`
        : '';
    const userSelect =
      users.length > 1
        ? `<select data-act="user" title="Acting as">${users.map((u) => `<option value="${u.id}"${u.id === this.userId ? ' selected' : ''}>🙂 ${esc(u.first_name)}</option>`).join('')}</select>`
        : '';
    return chatSelect + userSelect;
  }

  private empty() {
    const sim = this.sim!;
    return `<div class="empty"><b>${esc(sim.botInfo.first_name)}</b>@${esc(sim.botInfo.username)}<br>Send a message to start.</div>`;
  }

  private messages(chat: SimChat): { key: string; html: string }[] {
    const out: { key: string; html: string }[] = [];
    const items = chat.messages;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const group = item.message.media_group_id;
      if (group) {
        const album = [item];
        while (items[i + 1]?.message.media_group_id === group) album.push(items[++i]!);
        out.push({ key: `a${group}:${item.message.message_id}`, html: this.album(album, chat) });
        continue;
      }
      out.push({ key: `m${item.message.message_id}`, html: this.message(item, chat) });
    }
    return out;
  }

  private service(message: Message): string | null {
    const name = (u?: { first_name: string }) => u?.first_name ?? 'Someone';
    if (message.new_chat_members) return `${message.new_chat_members.map(name).join(', ')} joined the group`;
    if (message.left_chat_member) return `${name(message.left_chat_member)} left the group`;
    if (message.successful_payment) {
      const p = message.successful_payment;
      return `You paid ${amount(p.total_amount, p.currency)}`;
    }
    if (message.web_app_data) return `Data from the “${message.web_app_data.button_text}” button was transferred to the bot.`;
    if (message.pinned_message) return `${name(message.from)} pinned a message`;
    return null;
  }

  private message(item: SimMessage, chat: SimChat) {
    const m = item.message;
    const service = this.service(m);
    if (service) return `<div class="service">${esc(service)}</div>`;
    const key = `${chat.id}:${m.message_id}`;
    const media = this.mediaBlock(item);
    const sender = !item.fromBot && chat.type !== 'private' ? `<div class="sender">${esc(m.from?.first_name ?? '')}</div>` : '';
    const via = m.via_bot ? `<div class="via">via @${esc(m.via_bot.username ?? '')}</div>` : '';
    const reply = m.reply_to_message
      ? `<div class="quote"><b>${esc(m.reply_to_message.from?.first_name ?? '')}</b><span>${esc(m.reply_to_message.text ?? m.reply_to_message.caption ?? '📎 Media')}</span></div>`
      : '';
    const text = m.text ?? m.caption;
    const entities = m.text !== undefined ? m.entities : m.caption_entities;
    const body = text ? `<div class="text">${this.formatted(text, entities ?? [], key)}</div>` : '';
    const extra = this.extra(m);
    const meta = `<span class="meta">${m.edit_date ? 'edited ' : ''}${time(m.date)}${item.fromBot ? '' : ' ✓✓'}</span>`;
    const keyboard = this.inlineKeyboard(item);
    const isDice = !!m.dice && !text;
    const bubble = isDice
      ? `<div class="dice" title="${m.dice!.value}">${esc(m.dice!.emoji)}</div><div class="meta">${m.dice!.value}</div>`
      : `<div class="bubble${media ? ' media' : ''}">${sender}${via}${reply}${media}${extra}${body}${meta}</div>`;
    // The user's own messages sit on the right, like in their Telegram.
    return `<div class="row${item.fromBot ? '' : ' out'}" data-msg="${m.message_id}">${bubble}${keyboard}</div>`;
  }

  private album(items: SimMessage[], chat: SimChat) {
    const first = items[0]!;
    const captioned = items.find((i) => i.message.caption);
    const cells = items.map((i) => this.mediaBlock(i, true)).join('');
    const caption = captioned ? `<div class="text">${this.formatted(captioned.message.caption!, captioned.message.caption_entities ?? [], `${chat.id}:${captioned.message.message_id}`)}</div>` : '';
    return `<div class="row${first.fromBot ? '' : ' out'}"><div class="bubble media"><div class="album">${cells}</div>${caption}<span class="meta">${time(first.message.date)}</span></div></div>`;
  }

  private mediaBlock(item: SimMessage, compact = false) {
    const media = item.media;
    const m = item.message;
    if (!media && !m.invoice) return '';
    if (m.invoice && !media) return '';
    const kind = media!.kind;
    const url = media!.url;
    if ((kind === 'photo' || kind === 'sticker') && url) return `<img class="img" src="${esc(url)}" alt="" loading="lazy">`;
    if ((kind === 'video' || kind === 'animation') && url) {
      return `<video class="img" src="${esc(url)}" ${kind === 'animation' ? 'autoplay loop muted playsinline' : 'controls playsinline'}></video>`;
    }
    if (kind === 'photo' || kind === 'video' || kind === 'animation' || kind === 'sticker' || compact) {
      return `<div class="ph"><div><span>${MEDIA_ICON[kind] ?? '📎'}</span>${esc(media!.name ?? kind)}</div></div>`;
    }
    if (kind === 'audio' && url) return `<audio src="${esc(url)}" controls style="width:260px;margin:4px"></audio>`;
    const name = media!.name ?? kind;
    const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name);
    return `<div class="file"><div class="icon">${MEDIA_ICON[kind] ?? '📄'}</div><div>${link}<small>${kind}</small></div></div>`;
  }

  private extra(m: Message) {
    if (m.invoice) {
      const i = m.invoice;
      return `<div class="card"><div class="title">${esc(i.title)}</div><div>${esc(i.description)}</div><div class="amount">${esc(amount(i.total_amount, i.currency))}</div></div>`;
    }
    if (m.location) {
      const { latitude, longitude } = m.location;
      return `<div class="card">📍 <a href="https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}" target="_blank" rel="noopener">${latitude.toFixed(5)}, ${longitude.toFixed(5)}</a></div>`;
    }
    if (m.contact) return `<div class="card">👤 <b>${esc(m.contact.first_name)}</b><br>${esc(m.contact.phone_number)}</div>`;
    if (m.poll) return `<div class="card"><div class="title">📊 ${esc(m.poll.question)}</div>${m.poll.options.map((o) => `<div>○ ${esc(o.text)}</div>`).join('')}</div>`;
    if (m.forward_origin) return `<div class="via">Forwarded</div>`;
    return '';
  }

  private inlineKeyboard(item: SimMessage) {
    const rows = item.message.reply_markup?.inline_keyboard;
    if (!rows?.length) return '';
    return `<div class="keyboard">${rows
      .map(
        (row, r) =>
          `<div class="krow">${row
            .map((button, c) => {
              const id = `${item.message.message_id}:${r}:${c}`;
              return `<button class="kbtn${this.busy.has(`${item.message.chat.id}:${id}`) ? ' busy' : ''}" data-act="press" data-msg="${item.message.message_id}" data-r="${r}" data-c="${c}">${esc(button.text)}${corner(button)}</button>`;
            })
            .join('')}</div>`,
      )
      .join('')}</div>`;
  }

  /** Text with entities as HTML (entities are nested ranges; partial overlaps are clipped). */
  private formatted(text: string, entities: MessageEntity[], key: string): string {
    const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
    let spoiler = 0;
    const build = (from: number, to: number, list: MessageEntity[]): string => {
      let out = '';
      let cursor = from;
      let i = 0;
      while (i < list.length) {
        const entity = list[i]!;
        const start = Math.max(entity.offset, cursor);
        const end = Math.min(entity.offset + entity.length, to);
        if (start >= end) {
          i++;
          continue;
        }
        out += esc(text.slice(cursor, start));
        const inner: MessageEntity[] = [];
        let j = i + 1;
        while (j < list.length && list[j]!.offset < end) inner.push(list[j++]!);
        out += this.wrap(entity, text.slice(start, end), build(start, end, inner), key, spoiler++);
        cursor = end;
        i = j;
      }
      return out + esc(text.slice(cursor, to));
    };
    return build(0, text.length, sorted);
  }

  private wrap(entity: MessageEntity, raw: string, html: string, key: string, index: number): string {
    switch (entity.type) {
      case 'bold':
        return `<b>${html}</b>`;
      case 'italic':
        return `<i>${html}</i>`;
      case 'underline':
        return `<u>${html}</u>`;
      case 'strikethrough':
        return `<s>${html}</s>`;
      case 'code':
        return `<code>${html}</code>`;
      case 'pre':
        return `<pre><code>${html}</code></pre>`;
      case 'blockquote':
      case 'expandable_blockquote':
        return `<blockquote>${html}</blockquote>`;
      case 'spoiler': {
        const id = `${key}:${index}`;
        return `<span class="spoiler${this.revealed.has(id) ? ' shown' : ''}" data-act="spoiler" data-id="${esc(id)}">${html}</span>`;
      }
      case 'text_link':
        return `<a href="${esc(safeUrl(entity.url))}" target="_blank" rel="noopener">${html}</a>`;
      case 'url':
        return `<a href="${esc(safeUrl(raw.includes('://') ? raw : `https://${raw}`))}" target="_blank" rel="noopener">${html}</a>`;
      case 'email':
        return `<a href="mailto:${esc(raw)}">${html}</a>`;
      case 'bot_command':
        return `<span class="cmd" data-act="command" data-cmd="${esc(raw)}">${html}</span>`;
      case 'mention':
      case 'hashtag':
      case 'cashtag':
      case 'text_mention':
        return `<a>${html}</a>`;
      default:
        return html;
    }
  }

  private dock(chat: SimChat | undefined) {
    const sim = this.sim!;
    const member = chat?.members.get(this.userId);
    if (chat && chat.type !== 'private' && (!member || ['left', 'kicked'].includes(member.status))) {
      return `<div class="dock"><div class="input" style="justify-content:center;color:var(--tg-muted);font-size:14px;padding:14px">${member?.status === 'kicked' ? 'You were removed from this group' : `<button class="icon-btn menu" data-act="join">Join group</button>`}</div></div>`;
    }
    if (member?.status === 'restricted' && member.rights.can_send_messages === false) {
      return `<div class="dock"><div class="input" style="justify-content:center;color:var(--tg-muted);font-size:14px;padding:14px">The admins restricted you from writing here</div></div>`;
    }
    const keyboard = chat?.replyKeyboard;
    const showReply = keyboard && !chat!.replyKeyboardHidden;
    const placeholder = chat?.forceReply?.input_field_placeholder ?? (showReply ? keyboard!.input_field_placeholder : undefined) ?? 'Message';
    const panel =
      this.panel === 'commands'
        ? `<div class="panel">${sim.commands.map((c) => `<div class="item" data-act="command" data-cmd="/${esc(c.command)}"><div><b>/${esc(c.command)}</b><small>${esc(c.description)}</small></div></div>`).join('') || '<div class="hint">No commands set (setMyCommands)</div>'}</div>`
        : this.panel === 'inline'
          ? `<div class="panel">${this.inlinePanel()}</div>`
          : '';
    const replyRows = showReply
      ? `<div class="reply">${keyboard!.keyboard
          .map(
            (row, r) =>
              `<div class="krow">${row.map((b, c) => `<button class="kbtn" data-act="reply" data-r="${r}" data-c="${c}">${esc(typeof b === 'string' ? b : b.text)}${replyCorner(b)}</button>`).join('')}</div>`,
          )
          .join('')}</div>`
      : '';
    return `<div class="dock">${panel}
      <div class="input">
        ${sim.commands.length ? `<button class="icon-btn menu" data-act="menu" title="Commands">☰ Menu</button>` : ''}
        <button class="icon-btn" data-act="attach" title="Attach">📎</button>
        <input data-focus="text" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="send">
        ${keyboard ? `<button class="icon-btn" data-act="toggle-reply" title="${showReply ? 'Hide' : 'Show'} keyboard">${showReply ? '⌄' : '⌨'}</button>` : ''}
        <button class="icon-btn send" data-act="send" title="Send">➤</button>
      </div>${replyRows}</div>`;
  }

  private inlinePanel() {
    const state = this.inlineResults;
    if (!state) return '<div class="hint">Searching…</div>';
    if (!state.results.length) return '<div class="hint">No results</div>';
    return state.results
      .map((result, i) => {
        const r = result as InlineQueryResult & Record<string, any>;
        const thumb = r.thumbnail_url ?? r.photo_url;
        const title = r.title ?? r.type;
        return `<div class="item" data-act="inline" data-i="${i}">${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}<div><b>${esc(title)}</b>${r.description ? `<small>${esc(r.description)}</small>` : ''}</div></div>`;
      })
      .join('');
  }

  private renderModal(modal: Modal) {
    if (modal.kind === 'alert') {
      return `<div class="modal"><div class="dialog"><p>${esc(modal.text)}</p><div class="actions"><button data-act="close">OK</button></div></div></div>`;
    }
    if (modal.kind === 'attach') {
      return `<div class="modal" data-act="close-backdrop"><div class="dialog"><div class="title">Send</div>
        <div class="panel" style="max-height:none;border:none">
          <label class="item"><span>🖼</span><div>Photo<small>Pick an image</small></div><input type="file" accept="image/*" data-act="file-photo" hidden></label>
          <label class="item"><span>📄</span><div>File<small>Any file, as a document</small></div><input type="file" data-act="file-document" hidden></label>
          <div class="item" data-act="send-location"><span>📍</span><div>Location</div></div>
          <div class="item" data-act="send-contact"><span>👤</span><div>My contact</div></div>
        </div><div class="actions"><button data-act="close">Cancel</button></div></div></div>`;
    }
    const data = modal.button
      ? `<p>A Mini App would open here and could send data back with <code>Telegram.WebApp.sendData</code>. Send it:</p><textarea data-focus="webapp">{"ok":true}</textarea>`
      : `<p>This button opens a Mini App, which doesn't run in the simulator.</p>`;
    return `<div class="modal"><div class="dialog"><div class="title">Mini App</div><p><code>${esc(modal.url)}</code></p>${data}
      <div class="actions"><button data-act="open-webapp">Open page</button>${modal.button ? '<button data-act="send-webapp">Send data</button>' : ''}<button data-act="close">Close</button></div></div></div>`;
  }

  private toast(text: string) {
    this.root.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.root.querySelector('.root')?.append(el);
    setTimeout(() => el.remove(), 2300);
  }

  /* ------------------------------- actions ------------------------------- */

  private run(action: () => Promise<unknown>) {
    action().catch((error: unknown) => {
      this.errors.push((error as Error)?.message ?? String(error));
      this.schedule();
    });
  }

  private options() {
    return { user: this.userId, chat: this.chatId };
  }

  private sendText(text: string) {
    const sim = this.sim;
    if (!sim || !text.trim()) return;
    this.clearInput();
    this.panel = null;
    const reply = sim.chat(this.chatId)?.forceReply ? sim.last(this.chatId)?.message.message_id : undefined;
    this.run(() => sim.send(text, { ...this.options(), replyTo: reply }));
    this.schedule();
  }

  private onClick(event: MouseEvent) {
    const target = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    const sim = this.sim;
    if (!target || !sim) return;
    const act = target.dataset.act!;
    const chat = sim.chat(this.chatId);
    switch (act) {
      case 'send': {
        const input = this.root.querySelector('input[data-focus="text"]') as HTMLInputElement;
        this.sendText(input.value);
        break;
      }
      case 'press': {
        const messageId = Number(target.dataset.msg);
        const r = Number(target.dataset.r);
        const c = Number(target.dataset.c);
        const item = chat?.messages.find((m) => m.message.message_id === messageId);
        const button = item?.message.reply_markup?.inline_keyboard[r]?.[c];
        if (!item || !button) return;
        if ('switch_inline_query_current_chat' in button && button.switch_inline_query_current_chat !== undefined) {
          this.setDraft(`@${sim.botInfo.username} ${button.switch_inline_query_current_chat}`);
          return;
        }
        if ('switch_inline_query' in button && button.switch_inline_query !== undefined) {
          this.setDraft(`@${sim.botInfo.username} ${button.switch_inline_query}`);
          return;
        }
        if ('copy_text' in button && button.copy_text) {
          void navigator.clipboard?.writeText(button.copy_text.text).catch(() => undefined);
          this.toast('Copied to clipboard');
          return;
        }
        const busy = `${this.chatId}:${messageId}:${r}:${c}`;
        this.busy.add(busy);
        this.schedule();
        this.run(() =>
          sim.press(messageId, button, { ...this.options(), inlineMessageId: item.inlineMessageId }).finally(() => {
            this.busy.delete(busy);
            this.schedule();
          }),
        );
        break;
      }
      case 'reply': {
        const button = chat?.replyKeyboard?.keyboard[Number(target.dataset.r)]?.[Number(target.dataset.c)];
        if (!button) return;
        if (typeof button === 'object' && 'web_app' in button && button.web_app) {
          this.modal = { kind: 'webApp', url: button.web_app.url, button: button.text };
          this.schedule();
          return;
        }
        this.run(() => sim.pressReply(button as KeyboardButton, this.options()));
        break;
      }
      case 'toggle-reply':
        if (chat) chat.replyKeyboardHidden = !chat.replyKeyboardHidden;
        this.schedule();
        break;
      case 'command':
        this.sendText(target.dataset.cmd!);
        break;
      case 'spoiler':
        this.revealed.add(target.dataset.id!);
        this.schedule();
        break;
      case 'menu':
        this.panel = this.panel === 'commands' ? null : 'commands';
        this.schedule();
        break;
      case 'inline': {
        const state = this.inlineResults;
        const result = state?.results[Number(target.dataset.i)];
        if (!state || !result) return;
        this.clearInput();
        this.panel = null;
        this.inlineResults = null;
        this.run(() => sim.chooseInlineResult(result, state.query, this.options()));
        this.schedule();
        break;
      }
      case 'dismiss':
        this.errors.splice(Number(target.dataset.i), 1);
        this.schedule();
        break;
      case 'attach':
        this.modal = { kind: 'attach' };
        this.schedule();
        break;
      case 'send-location':
        this.modal = null;
        this.run(() => sim.sendLocation(-6.175392, 106.827153, this.options()));
        break;
      case 'send-contact':
        this.modal = null;
        this.run(() => sim.sendContact(undefined, this.options()));
        break;
      case 'join':
        this.run(() => sim.join(this.chatId, this.userId));
        break;
      case 'open-webapp':
        if (this.modal?.kind === 'webApp') globalThis.open?.(this.modal.url, '_blank', 'noopener');
        break;
      case 'send-webapp': {
        const modal = this.modal;
        const data = (this.root.querySelector('textarea[data-focus="webapp"]') as HTMLTextAreaElement | null)?.value ?? '';
        this.modal = null;
        if (modal?.kind === 'webApp' && modal.button) this.run(() => sim.sendWebAppData(data, modal.button!, this.options()));
        this.schedule();
        break;
      }
      case 'close':
        this.modal = null;
        this.schedule();
        break;
      case 'close-backdrop':
        if (event.target === target) {
          this.modal = null;
          this.schedule();
        }
        break;
    }
  }

  private clearInput() {
    this.draft = '';
    const input = this.root.querySelector('input[data-focus="text"]') as HTMLInputElement | null;
    if (input) input.value = '';
  }

  private setDraft(text: string) {
    this.draft = text;
    this.render();
    const input = this.root.querySelector('input[data-focus="text"]') as HTMLInputElement | null;
    if (input) input.value = text;
    input?.focus();
    this.searchInline(text);
  }

  private onKey(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement;
    if (input.dataset?.focus === 'text' && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (this.panel === 'inline') return;
      this.sendText(input.value);
    }
  }

  private onInput(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.dataset?.focus !== 'text') return;
    this.draft = input.value;
    this.searchInline(input.value);
  }

  private searchInline(text: string) {
    const sim = this.sim;
    if (!sim) return;
    const prefix = `@${sim.botInfo.username} `;
    clearTimeout(this.inlineTimer);
    if (!text.startsWith(prefix)) {
      if (this.panel === 'inline') {
        this.panel = null;
        this.inlineResults = null;
        this.schedule();
      }
      return;
    }
    const query = text.slice(prefix.length);
    if (this.panel !== 'inline') {
      this.panel = 'inline';
      this.inlineResults = null;
      this.schedule();
    }
    this.inlineTimer = setTimeout(() => {
      const chat = sim.chat(this.chatId);
      const chatType = !chat || chat.type === 'private' ? 'sender' : chat.type === 'group' ? 'group' : 'supergroup';
      this.run(async () => {
        const results = await sim.inlineQuery(query, { user: this.userId, chatType });
        if (this.draft === text) {
          this.inlineResults = { query, results };
          this.schedule();
        }
      });
    }, 250);
  }

  private onChange(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const sim = this.sim;
    if (!sim) return;
    const act = target.dataset.act;
    if (act === 'chat') this.chatId = Number(target.value);
    if (act === 'user') {
      this.userId = Number(target.value);
      const chat = sim.chat(this.chatId);
      if (chat?.type === 'private') this.chatId = this.userId;
    }
    if (act === 'file-photo' || act === 'file-document') {
      const file = (target as HTMLInputElement).files?.[0];
      this.modal = null;
      if (file) {
        const url = URL.createObjectURL(file);
        this.run(() => sim.sendMedia(act === 'file-photo' ? 'photo' : 'document', { url, name: file.name }, this.options()));
      }
      this.schedule();
    }
  }
}

function corner(button: InlineKeyboardButton): string {
  if ('url' in button || 'login_url' in button) return '<span class="corner">↗</span>';
  if ('web_app' in button) return '<span class="corner">⧉</span>';
  if ('switch_inline_query' in button || 'switch_inline_query_current_chat' in button || 'switch_inline_query_chosen_chat' in button) return '<span class="corner">↪</span>';
  if ('copy_text' in button) return '<span class="corner">⧉</span>';
  return '';
}

function replyCorner(button: KeyboardButton | string): string {
  if (typeof button === 'string') return '';
  if ('request_contact' in button && button.request_contact) return ' 👤';
  if ('request_location' in button && button.request_location) return ' 📍';
  if ('web_app' in button && button.web_app) return ' ⧉';
  return '';
}

function safeUrl(url: string) {
  return /^(https?:|tg:|mailto:)/i.test(url) ? url : '#';
}

function amount(total: number, currency: string) {
  if (currency === 'XTR') return `⭐️ ${total}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(total / 100);
  } catch {
    return `${total / 100} ${currency}`;
  }
}

/** Registers `<easytg-chat>` (done on import; safe to call again). */
export function defineChatElement(name = 'easytg-chat') {
  if (typeof customElements !== 'undefined' && !customElements.get(name)) customElements.define(name, EasyTGChatElement);
}

/** Put a chat window for `sim` into `container`. */
export function mountChat(container: Element, sim: TelegramSimulator, options: { chat?: number; user?: number; theme?: 'light' | 'dark' | 'auto' } = {}) {
  defineChatElement();
  const element = document.createElement('easytg-chat') as EasyTGChatElement;
  if (options.chat !== undefined) element.chatId = options.chat;
  if (options.user !== undefined) element.userId = options.user;
  if (options.theme) element.setAttribute('theme', options.theme);
  element.simulator = sim;
  container.append(element);
  return element;
}

defineChatElement();

declare global {
  interface HTMLElementTagNameMap {
    'easytg-chat': EasyTGChatElement;
  }
}
