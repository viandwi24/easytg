// Per-update state and the storage keys, constants and async context shared
// by the engine's modules. Internal: nothing here is exported by the package.
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { StoredCallback } from '../callback-store';
import type { Release } from '../coordination';
import { AsyncContext } from '../platform/context';
import { pressedMessage, type EditTarget } from '../render';
import type { Session } from '../session';
import type { Translate } from '../i18n';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const OWNER_TTL_MS = 7 * DAY_MS;
/** Long: a menu stays usable while it is in the chat (each render stores new tokens anyway). */
export const CALLBACK_TTL_MS = 365 * DAY_MS;
export const DEEP_LINK_TTL_MS = 365 * DAY_MS;
export const MAX_REDIRECTS = 5;
export const MAX_BACK_STEPS = 10;
export const MAX_NAV_MESSAGES = 20;

/** Session key of the per-message navigation history behind `nav.back()`. */
export const NAV_KEY = '_easytg:nav';
/** Session keys of the language chosen with `setLocale`, and of the Telegram app's language last seen. */
export const LOCALE_KEY = '_easytg:locale';
export const LAST_LANGUAGE_KEY = '_easytg:lang';
/** Session key of the message ids with a pending `deleteAfterMs`. */
export const AUTODELETE_KEY = '_easytg:autodelete';
/** Session key of the page that receives the user's text (`page.onText`). */
export const INPUT_KEY = '_easytg:input';
/** Session key: ids of the user's last updates in the chat (`dedupeUpdates`). */
export const UPDATES_KEY = '_easytg:updates';

/** Built-in tasks behind `deleteLater` / `sendLater` / `deleteAfterMs`. */
export const DELETE_TASK = '_easytg:delete';
export const SEND_TASK = '_easytg:send';
export const BROADCAST_TASK = '_easytg:broadcast';
export const REFRESH_TASK = '_easytg:refresh';

export interface View {
  id: string;
  params: Record<string, string>;
}

export interface TextInputState extends View {
  messageId: number;
}

/** Per menu message: the page it shows and the pages before it. */
export type NavHistory = Record<string, { current: View; stack: View[]; /** last used (ms) */ at?: number }>;

/** A menu message in the Back history: its id, or `e<id>` for an ephemeral message (ids of their own). */
export type MessageKey = number | string;

export function keyOf(message: Message): MessageKey {
  return message.ephemeral_message_id !== undefined ? `e${message.ephemeral_message_id}` : message.message_id;
}

/** The pressed message as a Back history key. */
export function pressedKey(ctx: Context): MessageKey | undefined {
  const pressed = pressedMessage(ctx);
  return pressed?.ephemeral ? `e${pressed.ephemeral.id}` : ctx.callbackQuery?.message?.message_id;
}

/** Per-update state: loaded session, stored buttons waiting to be written, answered flag. */
export interface UpdateScope {
  session?: Promise<Session>;
  /** Resolved language; undefined until the session is loaded. */
  locale?: string | null;
  pending: Map<string, StoredCallback>;
  pendingLinks: Map<string, StoredCallback>;
  answered: boolean;
  /** Back stack for the page being rendered. */
  navStack?: View[];
  /** The page actually rendered (after redirects). */
  view?: View;
  botScope?: string;
  /** `app.edit`: the message to edit, and don't send when it can't be edited. */
  editTarget?: EditTarget;
  noFallback?: boolean;
  /** Handled by the middleware (not a context created by `sendTo` etc.). */
  inUpdate?: boolean;
  /** Queue slots taken with `enterQueue`, released when the update ends. */
  held?: Release[];
  /** Proactive context of a user whose update is being handled: use that update's session. */
  sharedWith?: Context;
  /** `allowedUsers` of the pressed menu, kept for what the press renders. */
  allowedUsers?: number[];
  /** `app.t(ctx)`, created once. */
  t?: Translate;
  /** This update answers ephemerally (an `ephemeral` button or open): its later messages stay ephemeral too. */
  ephemeral?: boolean;
  /** The pressed message was already replaced by an ephemeral one (only the first one replaces it). */
  ephemeralReplaced?: boolean;
  /** The page or dialogue whose render (or onFinish) is running: where `nav` buttons lead from, for `flowchart`. */
  flowFrom?: string;
  userSession?: Promise<Session>;
  /** Loaded sessions, for synchronous access. */
  stateValue?: Session;
  userValue?: Session;
  /** `refreshEveryMs` of the page content just delivered. */
  refreshEveryMs?: number;
  /** A `refreshEveryMs` re-render: a pending `deleteAfterMs` keeps its deadline. */
  refreshing?: boolean;
  /** Redirects and dialogue starts in this update, against loops. */
  redirects?: number;
  /** Rendering a message that ends up in someone else's chat (Mini App results): buttons aren't bound to a user. */
  inlineRender?: boolean;
  /** A loading placeholder sent while rendering, for the page to replace. */
  placeholder?: { chatId: number; messageId: number };
  chatSession?: Promise<Session>;
}

/** The `UpdateScope` of each context, created on first use and dropped with the context. */
export class Scopes {
  private readonly scopes = new WeakMap<Context, UpdateScope>();

  constructor(private readonly scopeKeysByBot: boolean) {}

  get(ctx: Context): UpdateScope {
    let scope = this.scopes.get(ctx);
    if (!scope) {
      scope = { pending: new Map(), pendingLinks: new Map(), answered: false, botScope: this.botScope(ctx) };
      this.scopes.set(ctx, scope);
    }
    return scope;
  }

  /** The scope if there is one already, without creating it. */
  peek(ctx: Context): UpdateScope | undefined {
    return this.scopes.get(ctx);
  }

  /** Storage scope of bot-specific data. */
  botScope(ctx: Context): string {
    return this.scopeKeysByBot ? String(ctx.me.id) : '';
  }
}

/**
 * What the current async flow runs as: the user (`userKey`) whose update or
 * proactive render it is, and the queue slots it holds. Anything called from
 * inside (handlers, listeners, middlewares, jobs) sees it, which tells nested
 * calls from concurrent ones.
 */
export interface Flow {
  key?: string;
  ctx?: Context;
  queues: Set<string>;
}
export const flows = new AsyncContext<Flow>();

/** One user in one chat of one bot: the unit updates are serialized by. */
export function userKey(ctx: Context): string | undefined {
  const userId = ctx.from?.id;
  return userId === undefined ? undefined : `${ctx.me.id}:${ctx.chat?.id ?? 'global'}:${userId}`;
}

/** `bot` is '' when keys aren't scoped by bot (`scopeKeysByBot: false`). */
export function scoped(prefix: string, bot: string, ...parts: Array<string | number>) {
  return [prefix, ...(bot ? [bot] : []), ...parts].join(':');
}

export function sessionKey(ctx: Context, bot: string): string | null {
  const userId = ctx.from?.id;
  if (userId === undefined) return null;
  return scoped('session', bot, ctx.chat?.id ?? 'global', userId);
}

export function userSessionKey(ctx: Context, bot: string): string | null {
  const userId = ctx.from?.id;
  return userId === undefined ? null : scoped('usersession', bot, userId);
}

export function chatSessionKey(ctx: Context, bot: string): string | null {
  const chatId = ctx.chat?.id;
  return chatId === undefined ? null : scoped('chatsession', bot, chatId);
}

export function ownerKey(bot: string, chatId: number, messageId: number) {
  return scoped('msgowner', bot, chatId, messageId);
}

export function groupKey(bot: string, chatId: number, messageId: number) {
  return scoped('msggroup', bot, chatId, messageId);
}
