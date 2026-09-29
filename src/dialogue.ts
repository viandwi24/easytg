import type { Context } from 'grammy';
import type { InlineKeyboardButton, KeyboardButton, Message, ReplyKeyboardMarkup } from 'grammy/types';
import type { Dialogue } from './define';
import { EasyTGError } from './errors';
import { validateSchema, type StandardSchemaV1 } from './schema';
import type { EasyTG } from './engine';
import type { Session } from './session';
import type {
  Collected,
  DeliveryMode,
  DialogueCancelReason,
  DialogueFile,
  DialogueStep,
  PageContent,
  StepHelpers,
} from './types';

/** Session key holding the active dialogue. */
export const DIALOGUE_STATE_KEY = '_easytg:dialogue';
const DEFAULT_MAX_ITEMS = 50;

interface DialogueState {
  id: string;
  /** Random id per run, so buttons of an earlier run are recognised as stale. */
  run: string;
  step: number;
  params: Record<string, unknown>;
  answers: Record<string, unknown>;
  /** Prompt/ack/error messages to clean up on the next input. */
  messages: number[];
  collected?: Collected;
  /** The last prompt put buttons on the reply keyboard; they must be replaced when moving on. */
  replyKeyboard?: boolean;
  /** Last activity (ms), for timeouts. */
  at?: number;
}

type AnyDialogue<C extends Context> = Dialogue<any, any, C>;
type AnyStep<C extends Context> = DialogueStep<any, C>;

/** Steps whose buttons live on the reply keyboard (they send messages, not callbacks). */
function usesReplyKeyboard(step: DialogueStep<any, any>) {
  return step.type === 'contact' || step.type === 'location' || (step.type === 'choice' && !!step.reply);
}

/** Control button kinds, carried as `k` in the callback params. */
const Kind = { Choice: 'c', Action: 'a', Back: 'b', Cancel: 'x', Done: 'd' } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

export function extractFile(message: Message): DialogueFile | undefined {
  const caption = message.caption;
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1]!; // largest size
    return { kind: 'photo', fileId: photo.file_id, fileUniqueId: photo.file_unique_id, fileSize: photo.file_size, caption };
  }
  // `animation` messages also carry `document`, so check it first.
  const media =
    (message.animation && { kind: 'animation' as const, ...message.animation }) ||
    (message.video && { kind: 'video' as const, ...message.video }) ||
    (message.document && { kind: 'document' as const, ...message.document }) ||
    (message.audio && { kind: 'audio' as const, ...message.audio }) ||
    (message.voice && { kind: 'voice' as const, ...message.voice }) ||
    (message.video_note && { kind: 'video_note' as const, ...message.video_note }) ||
    (message.sticker && { kind: 'sticker' as const, ...message.sticker });
  if (!media) return undefined;
  return {
    kind: media.kind,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    fileName: 'file_name' in media ? media.file_name : undefined,
    fileSize: media.file_size,
    mimeType: 'mime_type' in media ? media.mime_type : undefined,
    caption: media.kind === 'sticker' || media.kind === 'video_note' ? undefined : caption,
  };
}

/** True for a /command addressed to this bot (`/cmd` or `/cmd@this_bot`, not `/cmd@other_bot`). */
export function isCommand(message: Message | undefined, botUsername?: string) {
  const first = message?.entities?.[0];
  if (first?.type !== 'bot_command' || first.offset !== 0) return false;
  const mention = message!.text?.slice(0, first.length).split('@')[1];
  return !mention || !botUsername || mention.toLowerCase() === botUsername.toLowerCase();
}

/** Runs dialogues for an app. Internal: use `app.startDialogue` / `nav.startDialogue`. */
export class DialogueRunner<C extends Context> {
  constructor(private readonly app: EasyTG<C>) {}

  async start(ctx: C, def: AnyDialogue<C>, params: Record<string, unknown>) {
    if (!ctx.chat) throw new EasyTGError(`Dialogue "${def.id}" can't start without a chat (e.g. from an inline-mode message)`);
    const session = await this.app.session(ctx);
    // Starting a dialogue abandons any other one that is still running.
    await this.abandon(ctx, session, ctx.callbackQuery?.message?.message_id);

    const state: DialogueState = { id: def.id, run: randomRun(), step: 0, params, answers: {}, messages: [] };
    this.save(session, state);
    this.app.logger.debug(`Dialogue "${def.id}" started`);
    await this.app.emit('dialogueStart', { ctx, dialogue: def.id, params });
    await this.show(ctx, session, def, state);
  }

  /** Feed a message to the active dialogue. Returns false if there is none. */
  async handleMessage(ctx: C): Promise<boolean> {
    const session = await this.app.session(ctx);
    await this.expireIdle(ctx, session);
    const active = this.active(session);
    if (!active) return false;
    const { def, state } = active;

    if (this.app.cancelDialogueOnCommand && isCommand(ctx.message, ctx.me?.username)) {
      await this.cancel(ctx, { render: false });
      return false; // let the command handler run
    }

    const message = ctx.message!;
    const text = message.text;
    const file = extractFile(message);
    const texts = this.app.textsFor(ctx);

    const step = await this.currentStep(ctx, def, state);
    if (step && usesReplyKeyboard(step)) {
      // Back and Cancel are reply buttons here too: they arrive as their label.
      if (text === texts.cancel) {
        await this.cancel(ctx, { render: true });
        return true;
      }
      if (text === texts.back && def.backEnabled && state.step > 0) {
        await this.goBack(ctx, session, def, state);
        return true;
      }
      if (step.type === 'contact' && message.contact) {
        const contact = message.contact;
        if (!step.allowOthers && contact.user_id !== ctx.from?.id) {
          return this.reject(ctx, session, def, state, texts.contactNotYours);
        }
        return this.submit(ctx, session, def, state, step, {
          phoneNumber: contact.phone_number,
          firstName: contact.first_name,
          lastName: contact.last_name,
          userId: contact.user_id,
          vcard: contact.vcard,
        });
      }
      if (step.type === 'location' && message.location) {
        const { latitude, longitude, horizontal_accuracy } = message.location;
        return this.submit(ctx, session, def, state, step, { latitude, longitude, horizontalAccuracy: horizontal_accuracy });
      }
      if (step.type === 'choice' && text !== undefined) {
        const option = step.options.find((o) => o.text === text);
        if (option) return this.submit(ctx, session, def, state, step, option.value);
      }
    }

    // Service messages (payments, web app data, members joining, …) aren't
    // dialogue input: let the app's own handlers see them.
    if (text === undefined && !file) return false;

    if (!step) {
      await this.finish(ctx, session, def, state);
      return true;
    }


    switch (step.type) {
      case 'text':
        if (text === undefined) return this.reject(ctx, session, def, state, texts.expectText);
        return this.submit(ctx, session, def, state, step, text, step.schema);
      case 'file':
        if (!file || (step.accept && !step.accept.includes(file.kind))) {
          return this.reject(ctx, session, def, state, texts.expectFile);
        }
        return this.submit(ctx, session, def, state, step, file);
      case 'choice':
        return this.reject(ctx, session, def, state, texts.expectChoice);
      case 'collect':
        return this.collect(ctx, session, def, state, step, text, file);
      case 'contact':
        return this.reject(ctx, session, def, state, texts.expectContact);
      case 'location':
        return this.reject(ctx, session, def, state, texts.expectLocation);
    }
  }

  /** Handle a dialogue control button. Returns false when the button is stale or forged. */
  async handleButton(ctx: C, params: Record<string, string>): Promise<boolean> {
    const session = await this.app.session(ctx);
    await this.expireIdle(ctx, session);
    const active = this.active(session);
    if (!active || params.r !== active.state.run) return false;
    const { def, state } = active;

    const steps = await this.steps(ctx, def, state);
    const step = steps[state.step];
    if (!step || params.s !== step.id) return false;

    switch (params.k) {
      case Kind.Choice: {
        // Callback data can be forged: only accept values this step offers.
        if (step.type !== 'choice' || !step.options.some((o) => o.value === params.v)) return false;
        await this.submit(ctx, session, def, state, step, params.v!);
        return true;
      }
      case Kind.Action: {
        const action = step.actions?.find((a) => a.id === params.v);
        if (!action) return false;
        const notice = await action.run(this.helpers(ctx, session, state));
        if (notice) await this.app.answerCallback(ctx, { text: notice });
        return true;
      }
      case Kind.Back: {
        if (!def.backEnabled || state.step === 0) return false;
        await this.goBack(ctx, session, def, state);
        return true;
      }
      case Kind.Cancel:
        await this.cancel(ctx, { render: true, keepMessageId: ctx.callbackQuery?.message?.message_id });
        return true;
      case Kind.Done: {
        if (step.type !== 'collect') return false;
        const items = state.collected ?? { texts: [], files: [] };
        const min = step.min ?? 1;
        if (items.texts.length + items.files.length < min) {
          await this.app.answerCallback(ctx, { text: this.app.textsFor(ctx).collectMin(min), show_alert: true });
          return true;
        }
        await this.submit(ctx, session, def, state, step, items);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Cancel the active dialogue. With `render`, `onCancel`'s result replaces the
   * kept message (the prompt whose Cancel was pressed), or that message is
   * deleted when there is no result.
   */
  async cancel(ctx: C, options: { render: boolean; keepMessageId?: number; reason?: DialogueCancelReason }): Promise<boolean> {
    const session = await this.app.session(ctx);
    await this.expireIdle(ctx, session); // a dialogue that already timed out ends as 'timeout'
    const active = this.active(session);
    if (!active) return false;
    const { def, state } = active;

    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, state, options.keepMessageId);
    if (state.replyKeyboard) await this.app.restoreKeyboard(ctx, this.app.textsFor(ctx).cancelled);
    await this.app.emit('dialogueCancel', { ctx, dialogue: def.id, params: state.params, answers: state.answers, reason: options.reason ?? (options.render ? 'user' : 'command') });
    const result = def.cancelFn ? await def.cancelFn(this.endArgs(ctx, session, state)) : undefined;

    if (options.render) {
      if (result) await this.app.showResult(ctx, result, 'edit');
      else await this.app.closeMessage(ctx);
    }
    return true;
  }

  private async goBack(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState) {
    const steps = await this.steps(ctx, def, state);
    await this.clear(ctx, state);
    const previous = steps[state.step - 1];
    state.step -= 1;
    if (previous) delete state.answers[previous.id];
    delete state.collected;
    this.save(session, state);
    await this.show(ctx, session, def, state);
  }

  // ---- internals -----------------------------------------------------------

  private save(session: Session, state: DialogueState) {
    state.at = Date.now();
    session.set(DIALOGUE_STATE_KEY, state);
  }

  /**
   * A dialogue idle for longer than its timeout ends (`reason: 'timeout'`,
   * onCancel's result ignored) before the update is looked at, so late input
   * goes to the app's own handlers and old buttons are reported as expired.
   */
  private async expireIdle(ctx: C, session: Session) {
    const active = this.active(session);
    if (!active) return;
    const timeout = active.def.timeoutMs ?? this.app.dialogueTimeoutMs;
    if (!timeout || Date.now() - (active.state.at ?? Date.now()) <= timeout) return;
    this.app.logger.debug(`Dialogue "${active.def.id}" timed out`);
    await this.end(ctx, session, active, 'timeout');
  }

  private active(session: Session): { def: AnyDialogue<C>; state: DialogueState } | null {
    const state = session.get<DialogueState>(DIALOGUE_STATE_KEY);
    if (!state || typeof state !== 'object') return null;
    const def = this.app.findDialogue(state.id);
    if (!def) {
      this.app.logger.warn(`Dropping state of unknown dialogue "${state.id}"`);
      session.delete(DIALOGUE_STATE_KEY);
      return null;
    }
    return { def, state };
  }

  private async abandon(ctx: C, session: Session, keepMessageId?: number) {
    await this.expireIdle(ctx, session);
    const active = this.active(session);
    if (active) await this.end(ctx, session, active, 'replaced', keepMessageId);
  }

  /** End a dialogue without showing onCancel's result (replaced, timed out). */
  private async end(ctx: C, session: Session, active: { def: AnyDialogue<C>; state: DialogueState }, reason: DialogueCancelReason, keepMessageId?: number) {
    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, active.state, keepMessageId);
    if (active.state.replyKeyboard) await this.app.restoreKeyboard(ctx, this.app.textsFor(ctx).cancelled);
    await this.app.emit('dialogueCancel', { ctx, dialogue: active.def.id, answers: active.state.answers, params: active.state.params, reason });
    try {
      await active.def.cancelFn?.(this.endArgs(ctx, session, active.state));
    } catch (error) {
      this.app.logger.error(`onCancel of dialogue "${active.def.id}" failed`, error);
    }
  }

  private async steps(ctx: C, def: AnyDialogue<C>, state: DialogueState): Promise<AnyStep<C>[]> {
    const steps = def.stepsDef!;
    return typeof steps === 'function' ? await steps({ ctx, params: state.params, answers: state.answers, t: this.app.t(ctx) }) : steps;
  }

  private async currentStep(ctx: C, def: AnyDialogue<C>, state: DialogueState) {
    return (await this.steps(ctx, def, state))[state.step];
  }

  private helpers(ctx: C, session: Session, state: DialogueState): StepHelpers<any, C> {
    const t = this.app.t(ctx);
    return { ctx, session, locale: this.app.localeOf(ctx), t, params: state.params, answers: state.answers, nav: this.app.nav(ctx), app: this.app };
  }

  private endArgs(ctx: C, session: Session, state: DialogueState) {
    return this.helpers(ctx, session, state);
  }

  /** Send the current step's prompt, or finish when there are no steps left. */
  private async show(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState) {
    // Resolved again every time, so dynamic steps can depend on the latest answers.
    const step = await this.currentStep(ctx, def, state);
    if (!step) return this.finish(ctx, session, def, state);
    const text = typeof step.text === 'function' ? await step.text(this.helpers(ctx, session, state)) : step.text;
    const { photo, video, animation, document, audio } = step;
    const media = { photo, video, animation, document, audio, parseMode: step.parseMode };

    if (usesReplyKeyboard(step)) {
      if (step.actions?.length) throw new EasyTGError(`Step "${step.id}" uses the reply keyboard and can't have actions`);
      state.replyKeyboard = true;
      await this.sendTracked(ctx, session, state, { text, ...media }, 'send', this.replyKeyboard(ctx, def, state, step));
      return;
    }
    if (state.replyKeyboard) {
      // Leaving a reply-keyboard step: put the menu back (or remove the buttons).
      state.replyKeyboard = false;
      await this.app.restoreKeyboard(ctx, this.app.textsFor(ctx).received);
    }

    const keyboard: InlineKeyboardButton[][] = [];
    if (step.type === 'choice') {
      const columns = Math.max(1, step.columns ?? 1);
      for (let i = 0; i < step.options.length; i += columns) {
        keyboard.push(step.options.slice(i, i + columns).map((o) => this.button(ctx, state, step, o.text, Kind.Choice, o.value)));
      }
    }
    if (step.actions?.length) {
      keyboard.push(step.actions.map((a) => this.button(ctx, state, step, a.text, Kind.Action, a.id)));
    }
    // A collect step shown again (after an error) keeps its Done button for what was sent so far.
    const collected = step.type === 'collect' && state.collected ? state.collected.texts.length + state.collected.files.length : 0;
    if (collected > 0) keyboard.push([this.button(ctx, state, step, this.app.textsFor(ctx).done, Kind.Done)]);
    keyboard.push(this.controls(ctx, def, state, step));
    await this.sendTracked(ctx, session, state, { text, ...media, keyboard });
  }

  private replyKeyboard(ctx: C, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>): ReplyKeyboardMarkup {
    const texts = this.app.textsFor(ctx);
    const rows: KeyboardButton[][] = [];
    if (step.type === 'contact') rows.push([{ text: step.button ?? texts.shareContact, request_contact: true }]);
    if (step.type === 'location') rows.push([{ text: step.button ?? texts.shareLocation, request_location: true }]);
    if (step.type === 'choice') {
      const columns = Math.max(1, step.columns ?? 1);
      for (let i = 0; i < step.options.length; i += columns) {
        rows.push(step.options.slice(i, i + columns).map((o) => ({ text: o.text })));
      }
    }
    const controls: KeyboardButton[] = [];
    if (def.backEnabled && state.step > 0) controls.push({ text: texts.back });
    controls.push({ text: texts.cancel });
    rows.push(controls);
    return { keyboard: rows, resize_keyboard: true, is_persistent: true };
  }

  private controls(ctx: C, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>): InlineKeyboardButton[] {
    const row: InlineKeyboardButton[] = [];
    if (def.backEnabled && state.step > 0) row.push(this.button(ctx, state, step, this.app.textsFor(ctx).back, Kind.Back));
    row.push(this.button(ctx, state, step, this.app.textsFor(ctx).cancel, Kind.Cancel));
    return row;
  }

  private button(ctx: C, state: DialogueState, step: AnyStep<C>, text: string, kind: Kind, value?: string): InlineKeyboardButton {
    return { text, callback_data: this.app.controlData(ctx, { r: state.run, s: step.id, k: kind, v: value }) };
  }

  private async sendTracked(
    ctx: C,
    session: Session,
    state: DialogueState,
    content: PageContent,
    mode: DeliveryMode = 'send',
    sendMarkup?: ReplyKeyboardMarkup,
  ) {
    const delivery = await this.app.deliverContent(ctx, content, mode, sendMarkup);
    if (delivery) state.messages.push(...delivery.sent);
    this.save(session, state);
  }

  /** Show an error, then the prompt again. Built-in texts go out as plain text; the app's own follow its parse mode. */
  private async reject(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState, error: string, builtIn = true) {
    await this.clear(ctx, state);
    await this.sendTracked(ctx, session, state, { text: error, parseMode: builtIn ? 'plain' : undefined });
    await this.show(ctx, session, def, state);
    return true;
  }

  private async submit(
    ctx: C,
    session: Session,
    def: AnyDialogue<C>,
    state: DialogueState,
    step: AnyStep<C>,
    value: unknown,
    schema?: StandardSchemaV1,
  ) {
    await this.clear(ctx, state);

    const validate = step.validate as ((value: unknown, helpers: StepHelpers<any, C>) => unknown) | undefined;
    const result = validate ? await validate(value, this.helpers(ctx, session, state)) : undefined;
    if (result !== undefined && result !== true) {
      // The collected items as a whole were rejected: start the step over.
      if (step.type === 'collect') delete state.collected;
      if (typeof result === 'string' && result) return this.reject(ctx, session, def, state, result, false);
      return this.reject(ctx, session, def, state, this.app.textsFor(ctx).invalidInput);
    }

    let answer = value;
    if (schema) {
      const parsed = await validateSchema(schema, value);
      if (!parsed.ok) return this.reject(ctx, session, def, state, parsed.message);
      answer = parsed.value;
    }

    state.answers[step.id] = answer;
    state.step += 1;
    delete state.collected;
    this.save(session, state);
    await this.show(ctx, session, def, state);
    return true;
  }

  private async collect(
    ctx: C,
    session: Session,
    def: AnyDialogue<C>,
    state: DialogueState,
    step: Extract<AnyStep<C>, { type: 'collect' }>,
    text: string | undefined,
    file: DialogueFile | undefined,
  ) {
    const kind = text !== undefined ? 'text' : file?.kind;
    if (!kind || (step.accept && !step.accept.includes(kind))) {
      return this.reject(ctx, session, def, state, this.app.textsFor(ctx).invalidInput);
    }

    const items = (state.collected ??= { texts: [], files: [] });
    const max = step.max ?? DEFAULT_MAX_ITEMS;
    const texts = this.app.textsFor(ctx);
    const doneRow = [this.button(ctx, state, step, texts.done, Kind.Done)];
    const keyboard = [doneRow, this.controls(ctx, def, state, step)];

    await this.clear(ctx, state); // one notice at a time
    if (items.texts.length + items.files.length >= max) {
      await this.sendTracked(ctx, session, state, { text: texts.collectLimit({ max, done: texts.done }), parseMode: 'plain', keyboard });
      return true;
    }
    if (text !== undefined) items.texts.push(text);
    else items.files.push(file!);

    const count = { total: items.texts.length + items.files.length, texts: items.texts.length, files: items.files.length, done: texts.done };
    await this.sendTracked(ctx, session, state, { text: texts.collectReceived(count), parseMode: 'plain', keyboard }, 'reply');
    return true;
  }

  private async finish(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState) {
    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, state);
    if (state.replyKeyboard) await this.app.restoreKeyboard(ctx, this.app.textsFor(ctx).received);
    this.app.logger.debug(`Dialogue "${def.id}" finished`);
    await this.app.emit('dialogueFinish', { ctx, dialogue: def.id, params: state.params, answers: state.answers });
    const result = await def.finishFn!(this.endArgs(ctx, session, state));
    await this.app.showResult(ctx, result, 'send');
  }

  /** Delete tracked messages, optionally keeping one (e.g. the one being edited). */
  private async clear(ctx: C, state: DialogueState, keepMessageId?: number) {
    const ids = state.messages.filter((id) => id !== keepMessageId);
    state.messages = [];
    if (!ids.length || !ctx.chat) return;
    try {
      for (let i = 0; i < ids.length; i += 100) await ctx.api.deleteMessages(ctx.chat.id, ids.slice(i, i + 100));
    } catch (error) {
      this.app.logger.debug('Failed to delete dialogue messages', error);
    }
  }
}

function randomRun() {
  return Math.random().toString(36).slice(2, 8);
}
