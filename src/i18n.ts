import { escapeHTML, escapeMarkdown, Formatted, markdownToHtml } from './format';

/** Plural forms, chosen by `vars.count` with the language's rules (`Intl.PluralRules`). */
export interface PluralMessage {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | PluralMessage;

/** Messages of one language. Nest them to group keys: `t('cart.empty')`. */
export interface Messages {
  [key: string]: Message | Messages;
}

export type TranslateVars = Record<string, string | number | boolean | null | undefined>;

/**
 * Translates your app's messages (the `i18n.messages` option) into the
 * user's language. `{name}` placeholders are replaced by `vars`.
 *
 *   t('hello', { name })         // plain string, for button labels and plain text
 *   t.md('hello', { name })      // Markdown message, vars escaped: safe for user input
 */
export interface Translate {
  (key: string, vars?: TranslateVars): string;
  /** The message as Markdown (the `markdown` parse mode), with every var escaped. */
  md(key: string, vars?: TranslateVars): Formatted;
  /** The message as Telegram HTML, with every var escaped. */
  html(key: string, vars?: TranslateVars): Formatted;
  /** Whether the key exists in the user's language or the fallback language. */
  has(key: string): boolean;
  /** The language messages come from (after fallbacks), if any. */
  readonly locale: string | undefined;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** `pt_BR`, `PT-br` → `pt-br`: language tags compared case- and separator-insensitively. */
export function normalizeLocale(locale: string): string {
  return locale.toLowerCase().replace(/_/g, '-');
}

export class Translator {
  private readonly messages = new Map<string, Messages>();
  private readonly cache = new Map<string, Translate>();
  private readonly warned = new Set<string>();

  constructor(
    messages: Record<string, Messages>,
    private readonly fallback: string | undefined,
    private readonly onMissing: (key: string, locale: string | undefined) => void,
  ) {
    for (const [locale, entries] of Object.entries(messages)) this.messages.set(normalizeLocale(locale), entries);
  }

  /** A `Translate` that looks the language up on every call, so a language change takes effect at once. */
  live(locale: () => string | undefined): Translate {
    const t = ((key: string, vars?: TranslateVars) => this.for(locale())(key, vars)) as Translate;
    t.md = (key, vars) => this.for(locale()).md(key, vars);
    t.html = (key, vars) => this.for(locale()).html(key, vars);
    t.has = (key) => this.for(locale()).has(key);
    Object.defineProperty(t, 'locale', { get: () => this.for(locale()).locale, enumerable: true });
    return t;
  }

  /** Whether any messages are configured. */
  get isEmpty() {
    return this.messages.size === 0;
  }

  /** A `Translate` for a user's language (`pt-br` falls back to `pt`, then to the fallback language). */
  for(locale: string | undefined): Translate {
    const key = locale ? normalizeLocale(locale) : '';
    let t = this.cache.get(key);
    if (!t) {
      t = this.create(key || undefined);
      this.cache.set(key, t);
    }
    return t;
  }

  private create(requested: string | undefined): Translate {
    const chain = [requested, requested?.split('-')[0], this.fallback && normalizeLocale(this.fallback)].filter(
      (l, i, all): l is string => !!l && all.indexOf(l) === i && this.messages.has(l),
    );
    const find = (key: string): { message: Message; locale: string } | undefined => {
      for (const locale of chain) {
        const message = lookup(this.messages.get(locale)!, key);
        if (message !== undefined) return { message, locale };
      }
      return undefined;
    };
    const format = (key: string, vars: TranslateVars | undefined, escape: (text: string) => string) => {
      const found = find(key);
      if (!found) {
        if (!this.warned.has(`${requested}:${key}`)) {
          this.warned.add(`${requested}:${key}`);
          this.onMissing(key, requested);
        }
        return key;
      }
      const template = typeof found.message === 'string' ? found.message : plural(found.message, found.locale, vars?.count);
      return template.replace(PLACEHOLDER, (match, name: string) =>
        vars && Object.hasOwn(vars, name) ? escape(vars[name] == null ? '' : String(vars[name])) : match,
      );
    };

    const t = ((key: string, vars?: TranslateVars) => format(key, vars, (v) => v)) as Translate;
    t.md = (key, vars) => {
      const source = format(key, vars, escapeMarkdown);
      return new Formatted(markdownToHtml(source), source);
    };
    t.html = (key, vars) => new Formatted(format(key, vars, escapeHTML));
    t.has = (key) => find(key) !== undefined;
    Object.defineProperty(t, 'locale', { value: chain[0], enumerable: true });
    return t;
  }
}

function lookup(messages: Messages, key: string): Message | undefined {
  const direct = messages[key];
  if (isMessage(direct)) return direct;
  let node: Message | Messages | undefined = messages;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || isPlural(node)) return undefined;
    node = (node as Messages)[part];
  }
  return isMessage(node) ? node : undefined;
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'string' || isPlural(value);
}

const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Plural forms only (so a group of messages may contain a key named `other`). */
function isPlural(value: unknown): value is PluralMessage {
  if (!value || typeof value !== 'object' || typeof (value as PluralMessage).other !== 'string') return false;
  return Object.entries(value).every(([form, text]) => PLURAL_FORMS.has(form) && typeof text === 'string');
}

const pluralRules = new Map<string, Intl.PluralRules>();

function plural(message: PluralMessage, locale: string, count: unknown): string {
  const n = Number(count);
  if (!Number.isFinite(n)) return message.other;
  if (n === 0 && message.zero !== undefined) return message.zero;
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRules.set(locale, rules);
  }
  return message[rules.select(n) as keyof PluralMessage] ?? message.other;
}
