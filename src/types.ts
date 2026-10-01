import type { Api, Context, InlineKeyboard, InputFile } from 'grammy';
import type { InlineKeyboardButton, LabeledPrice } from 'grammy/types';
import type { ParamValue, ParamsInput } from './callback';
import type { Dialogue, Page } from './define';
import type { EasyTG } from './engine';
import type { ParseMode, TextInput } from './format';
import type { Translate } from './i18n';
import type { StandardSchemaV1 } from './schema';
import type { Nav } from './nav';
import type { Session } from './session';

export type Awaitable<T> = T | Promise<T>;

/** Params as a page receives them: always strings (they come from callback data). */
export type Params = Record<string, string | undefined>;

/**
 * Constraint for declared params: every value is a string (optionally
 * undefined), because that's what arrives at runtime. Works for interfaces too.
 */
export type ParamsShape<P> = { [K in keyof P]: string | undefined };

/** Params as you pass them to a button/redirect; numbers and booleans are stringified. */
export type ParamsInputOf<P> = string extends keyof P
  ? ParamsInput
  : { [K in keyof P]: NonNullable<P[K]> | Exclude<ParamValue, string | null | undefined> };

export interface ButtonOptions {
  /** Store this button's params server-side regardless of `buttons.params`. */
  store?: boolean;
  /**
   * How the target page is shown when pressed: `edit` (default) replaces the
   * pressed message, `send` leaves it untouched and sends a new message — e.g.
   * for buttons under a video or document the user should keep.
   */
  mode?: 'edit' | 'send';
}

/** Params are optional when the target declares none (or only optional ones). */
/** Params only (for redirects and dialogue starts, which have no button options). */
export type ParamArgs<P> = {} extends P ? [params?: ParamsInputOf<P>] : [params: ParamsInputOf<P>];

export type ParamsArgs<P> = {} extends P
  ? [params?: ParamsInputOf<P>, options?: ButtonOptions]
  : [params: ParamsInputOf<P>, options?: ButtonOptions];

/**
 * A Telegram `file_id`, an HTTP(S) URL, or an `InputFile`. Local files must be
 * wrapped in `new InputFile(path)`, so user-provided strings never read disk.
 */
export type MediaSource = string | InputFile;

export type MediaType = 'photo' | 'video' | 'animation' | 'document' | 'audio';

/**
 * One media attachment, with `text` as its caption (caption text beyond 1024
 * characters continues in a new message). Use at most one of these.
 */
export interface MediaFields {
  photo?: MediaSource;
  video?: MediaSource;
  /** GIF or silent MP4. */
  animation?: MediaSource;
  document?: MediaSource;
  audio?: MediaSource;
}

/** A message to copy (`copyMessage`), e.g. media kept in a storage channel the bot can read. */
export interface CopySource {
  fromChatId: number | string;
  messageId: number;
}

/**
 * An invoice (`sendInvoice`). For digital goods use Telegram Stars:
 * `currency: 'XTR'` and no `providerToken`. Invoices are always sent as new
 * messages; a keyboard must start with `nav.pay(...)`.
 */
export interface InvoiceContent {
  title: string;
  description: string;
  /** Your reference (1–128 bytes), given back at checkout and payment. Not shown to the user. */
  payload: string;
  /** `XTR` (Telegram Stars) or a currency your payment provider supports. */
  currency: string;
  /** Amounts in the smallest unit (cents; whole Stars). */
  prices: LabeledPrice[];
  /** From @BotFather, for payments in currencies other than Stars. */
  providerToken?: string;
  /** More `sendInvoice` options: `photo_url`, `need_name`, `max_tip_amount`, `subscription_period`, … */
  options?: Omit<
    NonNullable<Parameters<Api['sendInvoice']>[6]>,
    'provider_token' | 'reply_markup' | 'reply_parameters' | 'protect_content' | 'message_thread_id'
  >;
}

export interface AlbumItem {
  type: 'photo' | 'video' | 'document' | 'audio';
  media: MediaSource;
}

export type KeyboardRow = ReadonlyArray<InlineKeyboardButton | false | null | undefined>;
/** Rows of buttons; falsy rows/buttons are dropped, so `isAdmin && nav.button(...)` works. */
export type KeyboardInput = ReadonlyArray<KeyboardRow | false | null | undefined> | InlineKeyboard;

export interface PageContent extends MediaFields {
  text?: TextInput;
  /**
   * 2–10 photos/videos (or documents, or audios) sent as one album. Albums
   * can't carry buttons: with a `keyboard`, `text` and the keyboard follow in
   * a separate message; without one, `text` becomes the album caption.
   */
  album?: AlbumItem[];
  /**
   * Copy an existing message (any media) instead of uploading, with `text` as
   * its new caption (without `text` the original caption stays). Copies are
   * always sent as new messages.
   */
  copy?: CopySource;
  /** Send an invoice (payments). Can't be combined with `text` or media. */
  invoice?: InvoiceContent;
  /** Falsy (e.g. `isAdmin && [...]`) means no keyboard. */
  keyboard?: KeyboardInput | false | null;
  /** How plain strings in `text` are parsed. Defaults to the app's `parseMode`. */
  parseMode?: ParseMode;
  /** Prevent forwarding and saving of the sent messages. Default: the app's `protectContent`. */
  protectContent?: boolean;
  /** Delete the message(s) after this many ms (a scheduled task: needs `app.startScheduler`). */
  deleteAfterMs?: number;
  /**
   * Render this page again into its message every this many ms (at least
   * 5000), for as long as the message still shows it: a live status, a
   * countdown. Uses the scheduler (`app.startScheduler`). Pages only.
   */
  refreshEveryMs?: number;
  /** Toast shown on the pressed button (button presses only). */
  toast?: string | { text: string; alert?: boolean };
  /** `false` disables link previews. */
  linkPreview?: boolean;
}

/** Returned by `nav.redirect(...)`: render another page instead. */
export class Redirect {
  constructor(
    readonly target: string,
    readonly params: Record<string, string>,
  ) {}
}

/** Returned by `nav.startDialogue(...)`: start a dialogue instead of showing content. */
export class DialogueStart {
  constructor(
    readonly dialogueId: string,
    readonly params: Record<string, unknown>,
  ) {}
}

export type RenderResult = PageContent | Redirect | DialogueStart | undefined | void;

export interface RenderArgs<P = Params, C extends Context = Context> {
  ctx: C;
  params: P;
  session: Session;
  /** The user's language (see the `locale` option), e.g. `"id"`. */
  locale: string | undefined;
  /** Your messages (`i18n.messages`) in the user's language. */
  t: Translate;
  nav: Nav<C>;
  page: Page<any, C, any>;
  app: EasyTG<C>;
}

export interface TextInputArgs<P = Params, C extends Context = Context> extends RenderArgs<P, C> {
  /** The text the user sent (untrusted input). */
  text: string;
}

export interface TextInputOptions {
  /**
   * `send` (default): show the result as a new message. `edit`: update the
   * page's message in place (sent anew if it can't be edited).
   */
  mode?: 'send' | 'edit';
  /** Delete the user's message after handling it (keeps the chat tidy with `mode: 'edit'`). Default false. */
  deleteInput?: boolean;
}

/** A chat action Telegram shows while the bot works: "typing…", "sending photo…". */
export type ChatAction = Parameters<Context['replyWithChatAction']>[0];

/**
 * What users see while a slow page renders. Nothing is shown if the render
 * is done within `afterMs`.
 */
export interface LoadingOptions {
  /** Show the indicators only if the work takes longer than this. Default 500. */
  afterMs?: number;
  /** A chat action ("typing…"), repeated every 4 s until done. */
  action?: ChatAction;
  /**
   * A placeholder: a pressed text menu shows it (without buttons) until the
   * page replaces it; otherwise it is sent as a message that the page then
   * replaces. Under media messages, it becomes a toast.
   */
  text?: TextInput;
  /** A toast on the pressed button (answers the press early). */
  toast?: string;
}

export interface MiddlewareArgs<C extends Context = Context> {
  ctx: C;
  /** Params of the page / dialogue (untrusted input). */
  params: Params;
  session: Session;
  locale: string | undefined;
  t: Translate;
  nav: Nav<C>;
  app: EasyTG<C>;
  /** The page about to render or the dialogue about to start. */
  target: Page<any, C, any> | Dialogue<any, any, C>;
}

/**
 * Runs before a page renders and before a dialogue starts (from a button, a
 * deep link, `nav.startDialogue` or `app.startDialogue`). Return `next()`
 * to continue, or your own result (content, `nav.redirect(...)`) to stop.
 */
export type Middleware<C extends Context = Context> = (
  args: MiddlewareArgs<C>,
  next: () => Promise<RenderResult>,
) => Awaitable<RenderResult>;

/**
 * How content reaches the chat:
 * - `send`  — new message
 * - `reply` — new message replying to the triggering message (if any)
 * - `edit`  — edit the pressed message; falls back to `send` if it can't
 * - `auto`  — `edit` for button presses, `reply` otherwise
 */
export type DeliveryMode = 'send' | 'reply' | 'edit' | 'auto';

// ---- dialogues --------------------------------------------------------------

export type FileKind = 'photo' | 'video' | 'animation' | 'document' | 'audio' | 'voice' | 'video_note' | 'sticker';

export interface DialogueFile {
  kind: FileKind;
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  caption?: string;
}

export interface Collected {
  texts: string[];
  files: DialogueFile[];
}

export interface DialogueContact {
  phoneNumber: string;
  firstName: string;
  lastName?: string;
  /** Telegram user id of the contact (always the sender, unless `allowOthers`). */
  userId?: number;
  vcard?: string;
}

export interface DialogueLocation {
  latitude: number;
  longitude: number;
  /** Radius of uncertainty in meters. */
  horizontalAccuracy?: number;
}

export interface StepHelpers<P = Params, C extends Context = Context> {
  ctx: C;
  session: Session;
  locale: string | undefined;
  t: Translate;
  params: P;
  /** Answers given so far, keyed by step id. */
  answers: Record<string, unknown>;
  nav: Nav<C>;
  app: EasyTG<C>;
}

/** `true`/nothing = valid, `false` = invalid (generic message), a string = invalid with that message. */
export type ValidateResult = boolean | string | void | undefined;

export interface StepAction<P = Params, C extends Context = Context> {
  id: string;
  text: string;
  /** Runs without advancing the dialogue. A returned string is shown as a toast. */
  run: (helpers: StepHelpers<P, C>) => Awaitable<string | void>;
}

interface StepBase<P, C extends Context> extends MediaFields {
  id: string;
  text: TextInput | ((helpers: StepHelpers<P, C>) => Awaitable<TextInput>);
  parseMode?: ParseMode;
  /** Extra inline buttons such as "Resend code" (not available on reply-keyboard steps). */
  actions?: readonly StepAction<P, C>[];
  /**
   * Ask this step only when this returns true (e.g. depending on an earlier
   * answer). A skipped step has no answer, so its answer is optional in the
   * inferred answers type.
   */
  when?: (helpers: StepHelpers<P, C>) => Awaitable<boolean>;
}

export type DialogueStep<P = Params, C extends Context = Context> =
  | (StepBase<P, C> & {
      /** Answer: the text (string), or the output of `schema`. */
      type: 'text';
      /** Runs on the text, before `schema`. */
      validate?: (value: string, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
      /**
       * A Standard Schema (zod, valibot, …) that checks and converts the text,
       * e.g. `z.coerce.number().int().min(1)`. Its first issue is shown as the
       * error, and its output becomes the answer.
       */
      schema?: StandardSchemaV1;
    })
  | (StepBase<P, C> & {
      /** Answer: a `DialogueFile`. */
      type: 'file';
      /** Accepted kinds. Default: all. */
      accept?: readonly FileKind[];
      validate?: (file: DialogueFile, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: the chosen option's `value`. Only listed values are accepted. */
      type: 'choice';
      options: readonly { text: string; value: string }[];
      /** Buttons per row. Default 1. */
      columns?: number;
      /** Show the options on the reply keyboard (below the input field) instead of as inline buttons. */
      reply?: boolean;
      validate?: (value: string, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: a `DialogueContact`, shared with a reply-keyboard button. */
      type: 'contact';
      /** Label of the share button. Default: `texts.shareContact`. */
      button?: string;
      /** Accept contacts other than the user's own. Default false. */
      allowOthers?: boolean;
      validate?: (contact: DialogueContact, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: a `DialogueLocation`, shared with a reply-keyboard button. */
      type: 'location';
      /** Label of the share button. Default: `texts.shareLocation`. */
      button?: string;
      validate?: (location: DialogueLocation, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /**
       * Answer: what a Mini App sends back with `Telegram.WebApp.sendData(...)`
       * (parsed as JSON when it is JSON), or the output of `schema`. The Mini
       * App opens from a reply-keyboard button. Private chats only.
       */
      type: 'webApp';
      /** The Mini App (https URL), e.g. a date picker, a map, a form. */
      url: string;
      /** Label of the button. Default: `texts.openWebApp`. */
      button?: string;
      /** A Standard Schema that checks (and converts) the data. The data comes from the client: check it. */
      schema?: StandardSchemaV1;
      validate?: (data: unknown, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: the chosen options' `value`s (in the order of `options`), picked with toggle buttons and Done. */
      type: 'multiChoice';
      options: readonly { text: string; value: string }[];
      /** Buttons per row. Default 1. */
      columns?: number;
      /** Default 1. */
      min?: number;
      /** Default: all. */
      max?: number;
      /** Chosen when the step is shown. */
      initial?: readonly string[];
      validate?: (values: string[], helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: a number, set with ➖ / ➕ buttons (then Done) or typed. */
      type: 'number';
      min?: number;
      max?: number;
      /** What ➖ / ➕ change. Default 1. */
      step?: number;
      /** Adds ⏪ / ⏩ buttons that change the number by this much. */
      bigStep?: number;
      /** Shown first. Default: `min`, or 0. */
      initial?: number;
      /** How the number is shown on its button, e.g. `(n) => \`${n} guests\``. */
      format?: (value: number) => string;
      validate?: (value: number, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /**
       * Answer: a date as `YYYY-MM-DD`, picked on an inline calendar (month and
       * day names in the user's language) or typed like that.
       */
      type: 'date';
      /** Earliest date: a `Date`, `YYYY-MM-DD`, or a function (evaluated each time, e.g. `() => new Date()` for "from today"). */
      min?: DateInput;
      /** Latest date, like `min`. */
      max?: DateInput;
      /** The month shown first (a date in it). Default: today, moved into `min`–`max`. */
      initial?: DateInput;
      /** First day of the week: 0 Sunday, 1 Monday (default). */
      weekStartsOn?: 0 | 1;
      validate?: (date: string, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: `{ texts, files }`, collected until the user presses Done. */
      type: 'collect';
      /** Accepted kinds. Default: text and all files. */
      accept?: readonly ('text' | FileKind)[];
      /** Default 1. */
      min?: number;
      /** Default 50. */
      max?: number;
      validate?: (items: Collected, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    });

/** A date for `date` steps: a `Date`, a `YYYY-MM-DD` string, or a function returning one. */
export type DateInput = Date | string | (() => Date | string);

/**
 * Why a dialogue ended without finishing: `user` pressed Cancel, `command` a
 * /command or menu button took over, `replaced` another dialogue started,
 * `app` your code called `app.cancelDialogue`, `timeout` it was idle too long.
 */
export type DialogueCancelReason = 'user' | 'command' | 'replaced' | 'app' | 'timeout';

export interface DialogueEndArgs<A, P, C extends Context> {
  ctx: C;
  session: Session;
  locale: string | undefined;
  t: Translate;
  params: P;
  answers: A;
  nav: Nav<C>;
  app: EasyTG<C>;
}
