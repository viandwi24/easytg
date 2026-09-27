import type { Context } from 'grammy';
import type { InlineKeyboardButton, Message } from 'grammy/types';
import type { Dialogue } from './define';
import { EasyTGError } from './errors';
import type { EasyTG } from './engine';
import type { Session } from './session';
import type {
  Collected,
  DeliveryMode,
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
}

type AnyDialogue<C extends Context> = Dialogue<any, any, C>;
type AnyStep<C extends Context> = DialogueStep<any, C>;

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
    session.set(DIALOGUE_STATE_KEY, state);
    this.app.logger.debug(`Dialogue "${def.id}" started`);
    await this.show(ctx, session, def, state);
  }

  /** Feed a message to the active dialogue. Returns false if there is none. */
  async handleMessage(ctx: C): Promise<boolean> {
    const session = await this.app.session(ctx);
    const active = this.active(session);
    if (!active) return false;
    const { def, state } = active;

    if (this.app.cancelDialogueOnCommand && isCommand(ctx.message, ctx.me?.username)) {
      await this.cancel(ctx, { render: false });
      return false; // let the command handler run
    }

    // Service messages (payments, web app data, members joining, …) aren't
    // dialogue input: let the app's own handlers see them.
    const message = ctx.message!;
    const text = message.text;
    const file = extractFile(message);
    if (text === undefined && !file) return false;

    const step = await this.currentStep(ctx, def, state);
    if (!step) {
      await this.finish(ctx, session, def, state);
      return true;
    }

    const texts = this.app.textsFor(ctx);

    switch (step.type) {
      case 'text':
        if (text === undefined) return this.reject(ctx, session, def, state, texts.expectText);
        return this.submit(ctx, session, def, state, step, text);
      case 'file':
        if (!file || (step.accept && !step.accept.includes(file.kind))) {
          return this.reject(ctx, session, def, state, texts.expectFile);
        }
        return this.submit(ctx, session, def, state, step, file);
      case 'choice':
        return this.reject(ctx, session, def, state, texts.expectChoice);
      case 'collect':
        return this.collect(ctx, session, def, state, step, text, file);
    }
  }

  /** Handle a dialogue control button. Returns false when the button is stale or forged. */
  async handleButton(ctx: C, params: Record<string, string>): Promise<boolean> {
    const session = await this.app.session(ctx);
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
        await this.clear(ctx, state);
        const previous = steps[state.step - 1];
        state.step -= 1;
        if (previous) delete state.answers[previous.id];
        delete state.collected;
        session.set(DIALOGUE_STATE_KEY, state);
        await this.show(ctx, session, def, state);
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
  async cancel(ctx: C, options: { render: boolean; keepMessageId?: number }): Promise<boolean> {
    const session = await this.app.session(ctx);
    const active = this.active(session);
    if (!active) return false;
    const { def, state } = active;

    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, state, options.keepMessageId);
    const result = def.cancelFn ? await def.cancelFn(this.endArgs(ctx, session, state)) : undefined;

    if (options.render) {
      if (result) await this.app.present(ctx, result, 'edit');
      else await this.app.closeMessage(ctx);
    }
    return true;
  }

  // ---- internals -----------------------------------------------------------

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
    const active = this.active(session);
    if (!active) return;
    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, active.state, keepMessageId);
    try {
      await active.def.cancelFn?.(this.endArgs(ctx, session, active.state));
    } catch (error) {
      this.app.logger.error(`onCancel of dialogue "${active.def.id}" failed`, error);
    }
  }

  private async steps(ctx: C, def: AnyDialogue<C>, state: DialogueState): Promise<AnyStep<C>[]> {
    const steps = def.stepsDef!;
    return typeof steps === 'function' ? await steps({ ctx, params: state.params, answers: state.answers }) : steps;
  }

  private async currentStep(ctx: C, def: AnyDialogue<C>, state: DialogueState) {
    return (await this.steps(ctx, def, state))[state.step];
  }

  private helpers(ctx: C, session: Session, state: DialogueState): StepHelpers<any, C> {
    return { ctx, session, locale: this.app.localeOf(ctx), params: state.params, answers: state.answers, nav: this.app.nav(ctx) };
  }

  private endArgs(ctx: C, session: Session, state: DialogueState) {
    return this.helpers(ctx, session, state);
  }

  /** Send the current step's prompt, or finish when there are no steps left. */
  private async show(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState) {
    // Resolved again every time, so dynamic steps can depend on the latest answers.
    const step = await this.currentStep(ctx, def, state);
    if (!step) return this.finish(ctx, session, def, state);

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
    keyboard.push(this.controls(ctx, def, state, step));

    const text = typeof step.text === 'function' ? await step.text(this.helpers(ctx, session, state)) : step.text;
    await this.sendTracked(ctx, session, state, { text, photo: step.photo, parseMode: step.parseMode, keyboard });
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

  private async sendTracked(ctx: C, session: Session, state: DialogueState, content: PageContent, mode: DeliveryMode = 'send') {
    const delivery = await this.app.deliverContent(ctx, content, mode);
    if (delivery) state.messages.push(...delivery.sent);
    session.set(DIALOGUE_STATE_KEY, state);
  }

  /** Show an error, then the prompt again. Built-in texts go out as plain text; the app's own follow its parse mode. */
  private async reject(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState, error: string, builtIn = true) {
    await this.clear(ctx, state);
    await this.sendTracked(ctx, session, state, { text: error, parseMode: builtIn ? 'plain' : undefined });
    await this.show(ctx, session, def, state);
    return true;
  }

  private async submit(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>, value: unknown) {
    await this.clear(ctx, state);

    const validate = step.validate as ((value: unknown, helpers: StepHelpers<any, C>) => unknown) | undefined;
    const result = validate ? await validate(value, this.helpers(ctx, session, state)) : undefined;
    if (result !== undefined && result !== true) {
      if (typeof result === 'string' && result) return this.reject(ctx, session, def, state, result, false);
      return this.reject(ctx, session, def, state, this.app.textsFor(ctx).invalidInput);
    }

    state.answers[step.id] = value;
    state.step += 1;
    delete state.collected;
    session.set(DIALOGUE_STATE_KEY, state);
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
    const doneRow = [this.button(ctx, state, step, this.app.textsFor(ctx).done, Kind.Done)];
    const keyboard = [doneRow, this.controls(ctx, def, state, step)];

    if (items.texts.length + items.files.length >= max) {
      await this.sendTracked(ctx, session, state, { text: this.app.textsFor(ctx).collectLimit(max), parseMode: 'plain', keyboard });
      return true;
    }
    if (text !== undefined) items.texts.push(text);
    else items.files.push(file!);

    await this.clear(ctx, state);
    const count = { total: items.texts.length + items.files.length, texts: items.texts.length, files: items.files.length };
    await this.sendTracked(ctx, session, state, { text: this.app.textsFor(ctx).collectReceived(count), parseMode: 'plain', keyboard }, 'reply');
    return true;
  }

  private async finish(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState) {
    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, state);
    this.app.logger.debug(`Dialogue "${def.id}" finished`);
    const result = await def.finishFn!(this.endArgs(ctx, session, state));
    await this.app.present(ctx, result, 'send');
  }

  /** Delete tracked messages, optionally keeping one (e.g. the one being edited). */
  private async clear(ctx: C, state: DialogueState, keepMessageId?: number) {
    const ids = state.messages.filter((id) => id !== keepMessageId);
    state.messages = [];
    if (!ids.length || !ctx.chat) return;
    try {
      await ctx.api.deleteMessages(ctx.chat.id, ids);
    } catch (error) {
      this.app.logger.debug('Failed to delete dialogue messages', error);
    }
  }
}

function randomRun() {
  return Math.random().toString(36).slice(2, 8);
}
