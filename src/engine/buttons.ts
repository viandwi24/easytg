// Buttons and deep links: callback data (inline, signed or stored tokens),
// checking inline params, and who may press a group menu.
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { DIALOGUE_BUTTON_ID, assertFits, encodeInline, fitsCallback, normalizeParams, type ParamsInput } from '../callback';
import { CallbackStore, type CallbackParamsMode, type StoredCallback } from '../callback-store';
import { encodeDeepLinkInline, encodeDeepLinkStored } from '../deeplink';
import type { EasyTG } from '../engine';
import { EasyTGError } from '../errors';
import { allowedUsersOf } from '../proactive';
import type { SentMessage } from '../render';
import { sign, verify } from '../sign';
import type { StorageAdapter } from '../storage';
import type { ButtonOptions } from '../types';
import { CALLBACK_TTL_MS, DEEP_LINK_TTL_MS, OWNER_TTL_MS, groupKey, ownerKey, type UpdateScope } from './scope';
import type { ButtonsOptions, DeepLinksOptions } from './types';

/** @internal */
export class Buttons<C extends Context> {
  readonly callbacks: CallbackStore;
  readonly deepLinks: CallbackStore;
  readonly mode: CallbackParamsMode;
  readonly ownerOnly: boolean;
  /** Param names starting with this are easytg's own (`buttons.reservedPrefix`). */
  readonly reserved: string;
  /** The param carrying a button's delivery mode (`{ mode: 'send' }`). */
  readonly modeKey: string;
  /** The param carrying a `signed` button's signature. */
  private readonly signatureKey: string;
  private readonly secret?: string;

  constructor(
    private readonly app: EasyTG<C>,
    /** Stored button params, deep-link params and message metadata. */
    readonly metaStorage: StorageAdapter,
    buttons: ButtonsOptions,
    deepLinks: DeepLinksOptions,
  ) {
    this.callbacks = new CallbackStore(metaStorage, buttons.ttlMs ?? CALLBACK_TTL_MS);
    this.deepLinks = new CallbackStore(metaStorage, deepLinks.ttlMs ?? DEEP_LINK_TTL_MS, 'dl:');
    this.mode = buttons.params ?? 'auto';
    this.secret = buttons.secret;
    if (this.mode === 'signed' && (!this.secret || this.secret.length < 16)) {
      throw new EasyTGError("buttons.params 'signed' needs buttons.secret with at least 16 characters");
    }
    this.ownerOnly = buttons.ownerOnly ?? true;
    this.reserved = buttons.reservedPrefix ?? '_';
    if (!this.reserved || /[\s|&=]/.test(this.reserved)) {
      throw new EasyTGError(`buttons.reservedPrefix must be a non-empty string without spaces, "|", "&" or "=" (got "${this.reserved}")`);
    }
    this.modeKey = `${this.reserved}m`;
    this.signatureKey = `${this.reserved}s`;
  }

  /** Callback data for a registered page/dialogue. */
  callbackData(ctx: C, id: string, params?: ParamsInput, options?: ButtonOptions): string {
    if (!this.app.pages.has(id) && !this.app.dialogueDefs.has(id)) {
      throw new EasyTGError(`"${id}" is not a registered page or dialogue`);
    }
    const normalized = normalizeParams(params);
    const reserved = Object.keys(normalized).find((key) => key.startsWith(this.reserved));
    if (reserved) throw new EasyTGError(`Param "${reserved}" of "${id}": names starting with "${this.reserved}" are reserved (see buttons.reservedPrefix)`);
    if (options?.mode === 'send') normalized[this.modeKey] = 's';
    if (options?.mode === 'ephemeral') normalized[this.modeKey] = 'e';
    const store = options?.store || (this.mode === 'stored' && Object.keys(normalized).length > 0);
    return this.encode(ctx, id, normalized, !!store);
  }

  /** Callback data for dialogue controls (checked against dialogue state, so inline is fine). */
  controlData(ctx: C, params: ParamsInput): string {
    return this.encode(ctx, DIALOGUE_BUTTON_ID, normalizeParams(params), false);
  }

  /** Deep link payload; `stored` is the entry to save when the params didn't fit inline. */
  deepLinkPayload(id: string, params?: ParamsInput, options?: ButtonOptions) {
    const target = this.app.pages.get(id) ?? this.app.dialogueDefs.get(id);
    if (!target) throw new EasyTGError(`"${id}" is not a registered page or dialogue`);
    if (!target.deepLinkEnabled) throw new EasyTGError(`"${id}" doesn't allow deep links: call .allowDeepLink() on it`);

    const normalized = normalizeParams(params);
    const store = options?.store || (this.mode === 'stored' && Object.keys(normalized).length > 0);
    if (!store) {
      const signed =
        this.mode === 'signed' && Object.keys(normalized).length > 0
          ? { ...normalized, [this.signatureKey]: sign(this.secret!, { botId: 0 }, id, normalized) }
          : normalized;
      const inline = encodeDeepLinkInline(id, signed);
      if (inline) return { payload: inline };
      if (this.mode === 'inline') throw new EasyTGError(`Deep link params for "${id}" don't fit in 64 characters`);
    }
    // Not bound to a user: deep links are meant to be shared.
    const entry: StoredCallback = { p: id, q: normalized };
    const token = this.deepLinks.tokenFor(entry);
    return { payload: encodeDeepLinkStored(token), stored: { token, entry } };
  }

  private encode(ctx: C, id: string, params: Record<string, string>, store: boolean): string {
    const boundUser = this.boundUser(ctx);
    if (!store) {
      const signed =
        this.mode === 'signed' && id !== DIALOGUE_BUTTON_ID && Object.keys(params).length > 0
          ? { ...params, [this.signatureKey]: sign(this.secret!, { botId: ctx.me.id, chatId: ctx.chat?.id, userId: boundUser }, id, params) }
          : params;
      const inline = encodeInline(id, signed);
      if (fitsCallback(inline)) return inline;
      // A dialogue's buttons carry its options' values, which the developer can't shorten
      // with `{ store: true }`: those are stored instead, even in 'inline' mode.
      if (this.mode === 'inline' && id !== DIALOGUE_BUTTON_ID) assertFits(inline); // throws
    }
    const entry: StoredCallback = { p: id, q: params, u: boundUser };
    const token = this.callbacks.tokenFor(entry, ctx.chat?.id);
    this.app.scopes.get(ctx).pending.set(token, entry);
    return `s|${token}`;
  }

  /** Whether inline params (from a client, so untrusted) may be used. Strips the signature. */
  acceptInline(ctx: C, id: string, params: Record<string, string>, deepLink = false): boolean {
    if (this.mode === 'stored') return false;
    if (this.mode !== 'signed') return true;
    const signature = params[this.signatureKey];
    delete params[this.signatureKey];
    const scope = deepLink ? { botId: 0 } : { botId: ctx.me.id, chatId: ctx.chat?.id };
    return verify(this.secret!, scope, deepLink ? undefined : ctx.from?.id, id, params, signature);
  }

  /**
   * The user a button is bound to: the one it was rendered for, when menus are
   * owner-only. Never for inline-mode messages (anyone in the chat may press
   * them) or messages with `allowedUsers` (checked through ownership instead).
   */
  private boundUser(ctx: C): number | undefined {
    const inlineMode = !!ctx.inlineQuery || !!ctx.callbackQuery?.inline_message_id || !!this.app.scopes.peek(ctx)?.inlineRender;
    return this.ownerOnly && !inlineMode && !this.allowedUsers(ctx) ? ctx.from?.id : undefined;
  }

  /** Users allowed to press this render's buttons: from `sendTo`, or inherited from the pressed menu. */
  allowedUsers(ctx: Context): number[] | undefined {
    return allowedUsersOf(ctx) ?? this.app.scopes.peek(ctx)?.allowedUsers;
  }

  /** Write the stored buttons and deep links rendered so far (before the message that uses them goes out). */
  async flush(scope: UpdateScope) {
    if (scope.pending.size === 0 && scope.pendingLinks.size === 0) return;
    const buttons = [...scope.pending];
    const links = [...scope.pendingLinks];
    scope.pending.clear();
    scope.pendingLinks.clear();
    const botScope = scope.botScope ?? '';
    await Promise.all([
      ...buttons.map(([token, entry]) => this.callbacks.write(token, entry, botScope)),
      ...links.map(([token, entry]) => this.deepLinks.write(token, entry)),
    ]);
  }

  async isMenuOwner(ctx: C): Promise<boolean> {
    const message = ctx.callbackQuery?.message;
    const userId = ctx.from?.id;
    if (!message || userId === undefined || message.chat.type === 'private') return true;

    const key = ownerKey(this.app.scopes.botScope(ctx), message.chat.id, message.message_id);
    const owner = await this.metaStorage.get(key);
    const allowed = typeof owner === 'number' ? owner === userId : Array.isArray(owner) ? owner.includes(userId) : undefined;
    if (allowed !== undefined) {
      if (!allowed) return false;
      // A menu shared by several users stays shared in what this press renders.
      if (Array.isArray(owner)) this.app.scopes.get(ctx).allowedUsers = owner.filter((id): id is number => typeof id === 'number');
      // Keep the ownership of a menu in use alive (it expires OWNER_TTL after the last press).
      await this.metaStorage.set(key, owner, OWNER_TTL_MS);
      return true;
    }
    if (!this.ownerOnly) return true;

    // Untracked (older) menu: fall back to the user it replied to.
    const repliedTo = (message as Message).reply_to_message?.from;
    if (repliedTo && !repliedTo.is_bot) return repliedTo.id === userId;
    return true;
  }

  /** Remember who a group menu belongs to, and which messages a long page was split into. */
  async onSent(ctx: Context, messages: SentMessage[]) {
    const last = messages.at(-1)!;
    const chatId = last.chat.id;
    const bot = this.app.scopes.botScope(ctx);
    const writes: Promise<void>[] = [];
    if (messages.length > 1) {
      const extra = messages.slice(0, -1).map((m) => m.message_id);
      writes.push(this.metaStorage.set(groupKey(bot, chatId, last.message_id), extra, OWNER_TTL_MS));
    }
    if (last.chat.type !== 'private') {
      // Who may press this message's buttons: explicit allowedUsers, or its user.
      const owners = this.allowedUsers(ctx) ?? (this.ownerOnly && ctx.from ? ctx.from.id : undefined);
      if (owners !== undefined) writes.push(this.metaStorage.set(ownerKey(bot, chatId, last.message_id), owners, OWNER_TTL_MS));
    }
    await Promise.all(writes);
  }

  async takeGroup(ctx: Context, chatId: number, messageId: number): Promise<number[]> {
    const key = groupKey(this.app.scopes.botScope(ctx), chatId, messageId);
    const ids = await this.metaStorage.get(key);
    if (!Array.isArray(ids) || ids.length === 0) return [];
    await this.metaStorage.delete(key);
    return ids.filter((id): id is number => typeof id === 'number');
  }
}
