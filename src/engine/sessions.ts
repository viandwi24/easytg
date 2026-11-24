// Sessions: loading (with migrations), sharing with a live update, and saving
// once per update. The user's language is resolved when the session loads.
import type { Context } from 'grammy';
import type { EasyTG } from '../engine';
import { EasyTGError } from '../errors';
import { isProactive } from '../proactive';
import { Session } from '../session';
import type { StorageAdapter } from '../storage';
import { LAST_LANGUAGE_KEY, LOCALE_KEY, chatSessionKey, sessionKey, userSessionKey, type UpdateScope } from './scope';
import type { SessionOptions } from './types';

/** @internal */
export class Sessions<C extends Context> {
  private readonly ttlMs?: number;
  private readonly refreshOnActivity: boolean;
  private readonly version?: number;
  private readonly migrate?: (data: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;

  constructor(
    private readonly app: EasyTG<C>,
    readonly storage: StorageAdapter,
    options: SessionOptions,
  ) {
    this.ttlMs = options.ttlMs;
    this.refreshOnActivity = options.refreshOnActivity ?? true;
    this.version = options.version;
    this.migrate = options.migrate;
    if (options.migrate && options.version === undefined) throw new EasyTGError('session.migrate needs session.version');
  }

  /** The session of the user in this chat; loading it also resolves the user's language. */
  state(ctx: C): Promise<Session> {
    const scope = this.app.scopes.get(ctx);
    const live = scope.sharedWith;
    if (live && !scope.session) {
      // The same session object as the update being handled, so both see (and save) each other's changes.
      scope.session = this.state(live as C).then((session) => {
        scope.locale = this.app.scopes.peek(live)?.locale ?? null;
        scope.stateValue = session;
        return session;
      });
    }
    scope.session ??= (async () => {
      // The language is the user's, in every chat: kept in the user session, if the app is translated.
      const [session, user] = await Promise.all([this.load(ctx), this.app.locales.translated && ctx.from ? this.user(ctx) : undefined]);
      const language = ctx.from?.language_code;
      // Remembered for messages sent without an update, which carry no language.
      if (user && language && !isProactive(ctx) && user.get(LAST_LANGUAGE_KEY) !== language) user.set(LAST_LANGUAGE_KEY, language);
      scope.locale = this.app.locales.resolve(ctx, session, user) ?? null;
      scope.stateValue = session;
      return session;
    })();
    return scope.session;
  }

  /** The user's session across all chats. */
  user(ctx: C): Promise<Session> {
    const scope = this.app.scopes.get(ctx);
    const live = scope.sharedWith;
    if (live && !scope.userSession) {
      scope.userSession = this.user(live as C).then((session) => (scope.userValue = session));
    }
    scope.userSession ??= (async () => {
      const key = userSessionKey(ctx, this.app.scopes.botScope(ctx));
      const session = key ? this.migrated(new Session(await this.storage.get(key))) : new Session();
      scope.userValue = session;
      return session;
    })();
    return scope.userSession;
  }

  /** State shared by everyone in the chat. */
  chat(ctx: C): Promise<Session> {
    const scope = this.app.scopes.get(ctx);
    const live = scope.sharedWith;
    if (live && !scope.chatSession && live.chat?.id === ctx.chat?.id) scope.chatSession = this.chat(live as C);
    scope.chatSession ??= (async () => {
      const key = chatSessionKey(ctx, this.app.scopes.botScope(ctx));
      if (!key) throw new EasyTGError('chatSession needs a chat');
      return this.migrated(new Session(await this.storage.get(key)));
    })();
    return scope.chatSession;
  }

  /** The session, once `state(ctx)` has been awaited. */
  loaded(ctx: C): Session {
    const session = this.app.scopes.get(ctx).stateValue;
    if (!session) throw new EasyTGError('The session is not loaded yet: await app.session(ctx) first');
    return session;
  }

  async setLocale(ctx: C, locale: string | undefined): Promise<void> {
    const session = await this.state(ctx);
    const user = await this.user(ctx);
    if (locale) user.set(LOCALE_KEY, locale);
    else user.delete(LOCALE_KEY);
    this.app.scopes.get(ctx).locale = this.app.locales.resolve(ctx, session, user) ?? null;
  }

  /** Save the sessions this update loaded, each merged per key with what is stored now. */
  async save(ctx: C, scope: UpdateScope) {
    const bot = this.app.scopes.botScope(ctx);
    if (scope.chatSession) {
      const key = chatSessionKey(ctx, bot);
      if (key) await this.write(await scope.chatSession, key);
    }
    if (scope.userSession) {
      const key = userSessionKey(ctx, bot);
      if (key) await this.write(await scope.userSession, key);
    }
    if (!scope.session) return;
    const key = sessionKey(ctx, bot);
    if (key) await this.write(await scope.session, key);
  }

  /**
   * Saves only this update's changes on top of what is stored now: two updates
   * of the same chat can overlap (a slow handler past the per-user lock's wait,
   * `app.sendTo` from a job), and the later one must not undo the other's.
   */
  private async write(session: Session, key: string) {
    const now = Date.now();
    const ttl = this.ttlMs;
    session.detectChanges();
    // Keep active users' sessions alive without writing on every update.
    const refresh =
      !!ttl && this.refreshOnActivity && session.savedAt !== undefined && now - session.savedAt > ttl / 2;
    if (!session.dirty && !refresh) return;

    session.dirty = false;
    session.mergeWith(await this.storage.get(key));
    if (session.isEmpty) {
      session.savedAt = undefined;
      await this.storage.delete(key);
    } else {
      session.savedAt = now;
      await this.storage.set(key, session.serialize(now), ttl);
    }
  }

  private async load(ctx: C): Promise<Session> {
    const key = sessionKey(ctx, this.app.scopes.botScope(ctx));
    if (!key) {
      // Normal for sendTo/edit to a group without a user; unexpected for updates.
      const message = 'No user for this context; using a temporary session that is not saved';
      if (isProactive(ctx)) this.app.logger.debug(message);
      else this.app.logger.warn(message);
      return new Session();
    }
    return this.migrated(new Session(await this.storage.get(key)));
  }

  private migrated(session: Session): Session {
    if (this.version !== undefined) session.migrate(this.version, this.migrate);
    return session;
  }
}
