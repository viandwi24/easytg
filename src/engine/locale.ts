// The user's language: built-in texts per language, and `t` for the app's own messages.
import type { Context } from 'grammy';
import type { EasyTG } from '../engine';
import { Translator, normalizeLocale, type Translate } from '../i18n';
import type { Session } from '../session';
import { defaultTexts, type EasyTGTexts } from '../texts';
import { LAST_LANGUAGE_KEY, LOCALE_KEY } from './scope';
import type { I18nOptions } from './types';

/** @internal */
export class Locales<C extends Context> {
  readonly texts: EasyTGTexts;
  readonly translator: Translator;
  readonly fallbackLocale: string;
  /** Languages of `i18n.messages` and `i18n.locales`, normalized. */
  readonly names: string[];
  private readonly locales: Record<string, Partial<EasyTGTexts>>;
  private readonly localeTexts = new Map<string, EasyTGTexts>();
  private readonly localeFn?: (ctx: C, session: Session) => string | undefined;

  constructor(
    private readonly app: EasyTG<C>,
    i18n: I18nOptions<C>,
  ) {
    this.texts = { ...defaultTexts, ...i18n.texts };
    this.translator = new Translator(i18n.messages ?? {}, i18n.fallbackLocale ?? 'en', (key, locale) =>
      this.app.logger.warn(`Missing message "${key}" (language: ${locale ?? 'none'})`),
    );
    this.locales = Object.fromEntries(Object.entries(i18n.locales ?? {}).map(([locale, texts]) => [normalizeLocale(locale), texts]));
    this.localeFn = i18n.locale;
    this.fallbackLocale = i18n.fallbackLocale ?? 'en';
    this.names = [...new Set([...Object.keys(i18n.messages ?? {}), ...Object.keys(i18n.locales ?? {})].map(normalizeLocale))];
  }

  /** Whether the app is translated at all: only then is the language kept in the user session. */
  get translated(): boolean {
    return !this.translator.isEmpty || Object.keys(this.locales).length > 0;
  }

  /**
   * An explicit choice (`setLocale`), else `i18n.locale`, else the Telegram
   * app's language, else (for `sendTo` & co, which have no language) the one
   * the user had when they last wrote.
   */
  resolve(ctx: C, session: Session, user: Session | undefined): string | undefined {
    const chosen = user?.get<string>(LOCALE_KEY);
    if (chosen) return chosen;
    if (this.localeFn) return this.localeFn(ctx, session);
    return ctx.from?.language_code ?? user?.get<string>(LAST_LANGUAGE_KEY);
  }

  localeOf(ctx: C): string | undefined {
    const resolved = this.app.scopes.peek(ctx)?.locale;
    return (resolved === undefined ? ctx.from?.language_code : resolved) ?? undefined;
  }

  t(ctx: C | string | undefined): Translate {
    if (typeof ctx !== 'object') return this.translator.for(ctx);
    const scope = this.app.scopes.get(ctx);
    return (scope.t ??= this.translator.live(() => this.localeOf(ctx)));
  }

  textsFor(ctx: C): EasyTGTexts {
    const requested = this.localeOf(ctx);
    if (!requested) return this.texts;
    const locale = normalizeLocale(requested);
    const key = [locale, locale.split('-')[0]!].find((l) => Object.hasOwn(this.locales, l));
    if (!key) return this.texts;
    let texts = this.localeTexts.get(key);
    if (!texts) {
      texts = { ...this.texts, ...this.locales[key] };
      this.localeTexts.set(key, texts);
    }
    return texts;
  }
}
