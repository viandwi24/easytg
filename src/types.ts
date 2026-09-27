import type { Context, InlineKeyboard, InputFile } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { ParamValue, ParamsInput } from './callback';
import type { Dialogue, Page } from './define';
import type { EasyTG } from './engine';
import type { ParseMode, TextInput } from './format';
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
  /** Falsy (e.g. `isAdmin && [...]`) means no keyboard. */
  keyboard?: KeyboardInput | false | null;
  /** How plain strings in `text` are parsed. Defaults to the app's `parseMode`. */
  parseMode?: ParseMode;
  /** Prevent forwarding and saving of the sent messages. Default: the app's `protectContent`. */
  protectContent?: boolean;
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
  nav: Nav<C>;
  page: Page<any, C, any>;
  app: EasyTG<C>;
}

export interface MiddlewareArgs<C extends Context = Context> {
  ctx: C;
  /** Params of the page / dialogue (untrusted input). */
  params: Params;
  session: Session;
  locale: string | undefined;
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
  params: P;
  /** Answers given so far, keyed by step id. */
  answers: Record<string, unknown>;
  nav: Nav<C>;
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
  actions?: StepAction<P, C>[];
}

export type DialogueStep<P = Params, C extends Context = Context> =
  | (StepBase<P, C> & {
      /** Answer: the text (string). */
      type: 'text';
      validate?: (value: string, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: a `DialogueFile`. */
      type: 'file';
      /** Accepted kinds. Default: all. */
      accept?: FileKind[];
      validate?: (file: DialogueFile, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    })
  | (StepBase<P, C> & {
      /** Answer: the chosen option's `value`. Only listed values are accepted. */
      type: 'choice';
      options: { text: string; value: string }[];
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
      /** Answer: `{ texts, files }`, collected until the user presses Done. */
      type: 'collect';
      /** Accepted kinds. Default: text and all files. */
      accept?: Array<'text' | FileKind>;
      /** Default 1. */
      min?: number;
      /** Default 50. */
      max?: number;
      validate?: (items: Collected, helpers: StepHelpers<P, C>) => Awaitable<ValidateResult>;
    });

export interface DialogueEndArgs<A, P, C extends Context> {
  ctx: C;
  session: Session;
  locale: string | undefined;
  params: P;
  answers: A;
  nav: Nav<C>;
}
