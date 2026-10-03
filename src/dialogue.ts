import type { Context } from 'grammy';
import type { InlineKeyboardButton, KeyboardButton, Message, ReplyKeyboardMarkup } from 'grammy/types';
import type { Dialogue } from './define';
import { EasyTGError } from './errors';
import { validateSchema, type StandardSchemaV1 } from './schema';
import { sha256, toBase64Url } from './platform/crypto';
import { addStep, calendar, checkTimeZone, inRange, numberInRange, parseIsoDate, resolveDate, startMonth, validMonth } from './steps';
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
  /** The same, sent as ephemeral messages (a dialogue started ephemerally in a group). */
  ephemeralMessages?: { chatId: number; receiverUserId: number; id: number }[];
  collected?: Collected;
  /** Options chosen so far in a `multiChoice` step. */
  selected?: string[];
  /** What a `number` / `date` widget shows now (the number, the month), kept when the prompt is sent again. */
  view?: string;
  /** The last prompt put buttons on the reply keyboard; they must be replaced when moving on. */
  replyKeyboard?: boolean;
  /** Last activity (ms), for timeouts. */
  at?: number;
}

type AnyDialogue<C extends Context> = Dialogue<any, any, C>;
type AnyStep<C extends Context> = DialogueStep<any, C>;

/** Steps whose buttons live on the reply keyboard (they send messages, not callbacks). */
function usesReplyKeyboard(step: DialogueStep<any, any>) {
  return step.type === 'contact' || step.type === 'location' || step.type === 'webApp' || (step.type === 'choice' && !!step.reply);
}

/** Control button kinds, carried as `k` in the callback params. */
const Kind = { Choice: 'c', Action: 'a', Back: 'b', Cancel: 'x', Done: 'd', Toggle: 't', Set: 'n', Page: 'p', Pick: 'y', Noop: 'o' } as const;
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
    const session = await this.app.state(ctx);
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
    const session = await this.app.state(ctx);
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
      if (step.type === 'webApp' && message.web_app_data) {
        return this.submit(ctx, session, def, state, step, parseWebAppData(message.web_app_data.data), step.schema);
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
      case 'webApp':
        return this.reject(ctx, session, def, state, texts.expectWebApp);
      case 'multiChoice':
        return this.reject(ctx, session, def, state, texts.expectChoice);
      case 'number': {
        const value = text === undefined ? NaN : Number(text.trim().replace(',', '.'));
        if (text === undefined || !text.trim() || !numberInRange(value, step)) return this.reject(ctx, session, def, state, texts.expectNumber!(step));
        return this.submit(ctx, session, def, state, step, value);
      }
      case 'date': {
        const { min, max } = this.dateBounds(ctx, state, step);
        const date = text === undefined ? undefined : parseIsoDate(text);
        if (!date || !inRange(date, min, max)) return this.reject(ctx, session, def, state, texts.expectDate!);
        return this.submit(ctx, session, def, state, step, date);
      }
    }
  }

  /** Handle a dialogue control button. Returns false when the button is stale or forged. */
  async handleButton(ctx: C, params: Record<string, string>): Promise<boolean> {
    const session = await this.app.state(ctx);
    await this.expireIdle(ctx, session);
    const active = this.active(session);
    if (!active || params.r !== active.state.run) return false;
    const { def, state } = active;

    const steps = await this.steps(ctx, def, state);
    const step = steps[state.step];
    // Buttons sent by earlier versions carry the whole step id: still accepted, so an upgrade doesn't break dialogues in progress.
    if (!step || (params.s !== stepKey(step.id) && params.s !== step.id)) return false;

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
      case Kind.Toggle: {
        if (step.type !== 'multiChoice' || !step.options.some((o) => o.value === params.v)) return false;
        const selected = this.selection(state, step);
        if (selected.includes(params.v!)) state.selected = selected.filter((v) => v !== params.v);
        else if (step.max !== undefined && selected.length >= step.max) {
          await this.app.answerCallback(ctx, { text: this.app.textsFor(ctx).chooseAtMost!(step.max), show_alert: true });
          return true;
        } else state.selected = [...selected, params.v!];
        this.save(session, state);
        await this.refresh(ctx, session, def, state, step);
        return true;
      }
      case Kind.Set: {
        const value = Number(params.v);
        if (step.type !== 'number' || !numberInRange(value, step)) return false;
        await this.refresh(ctx, session, def, state, step, params.v);
        return true;
      }
      case Kind.Page: {
        if (step.type !== 'date') return false;
        const { min, max } = this.dateBounds(ctx, state, step);
        if (!validMonth(params.v ?? '', min, max)) return false;
        await this.refresh(ctx, session, def, state, step, params.v);
        return true;
      }
      case Kind.Pick: {
        if (step.type !== 'date') return false;
        const { min, max } = this.dateBounds(ctx, state, step);
        const date = parseIsoDate(params.v ?? '');
        if (!date || !inRange(date, min, max)) return false;
        await this.submit(ctx, session, def, state, step, date);
        return true;
      }
      case Kind.Noop:
        return true;
      case Kind.Done: {
        if (step.type === 'multiChoice') {
          const selected = this.selection(state, step);
          const min = step.min ?? 1;
          if (selected.length < min) {
            await this.app.answerCallback(ctx, { text: this.app.textsFor(ctx).chooseAtLeast!(min), show_alert: true });
            return true;
          }
          // In the order of the options, whatever order they were pressed in.
          await this.submit(ctx, session, def, state, step, step.options.map((o) => o.value).filter((v) => selected.includes(v)));
          return true;
        }
        if (step.type === 'number') {
          const value = Number(params.v);
          if (!numberInRange(value, step)) return false;
          await this.submit(ctx, session, def, state, step, value);
          return true;
        }
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
    const session = await this.app.state(ctx);
    await this.expireIdle(ctx, session); // a dialogue that already timed out ends as 'timeout'
    const active = this.active(session);
    if (!active) return false;
    const { def, state } = active;

    session.delete(DIALOGUE_STATE_KEY);
    await this.clear(ctx, state, options.keepMessageId);
    if (state.replyKeyboard) await this.app.restoreKeyboard(ctx, this.app.textsFor(ctx).cancelled);
    await this.app.emit('dialogueCancel', { ctx, dialogue: def.id, params: state.params, answers: state.answers, reason: options.reason ?? (options.render ? 'user' : 'command') });
    this.app.setFlowSource(ctx, def.id);
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
    delete state.selected;
    delete state.view;
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

  /** The steps as they are now: evaluated for the answers so far, without the ones whose `when` says no. */
  private async steps(ctx: C, def: AnyDialogue<C>, state: DialogueState): Promise<readonly AnyStep<C>[]> {
    const defined = def.stepsDef!;
    const steps = typeof defined === 'function' ? await defined({ ctx, params: state.params, answers: state.answers, t: this.app.t(ctx) }) : defined;
    if (!steps.some((step) => step.when)) return steps;
    const helpers = this.helpers(ctx, undefined as never, state);
    const asked: AnyStep<C>[] = [];
    for (const step of steps) {
      // `when` is asked once the dialogue gets there: every step before it is
      // answered, so it can rely on those answers. Steps further ahead are
      // counted as asked for now (only the steps up to the current one matter).
      const reached = asked.every((s) => s.id in state.answers);
      if (step.when && reached && !(await step.when(helpers))) continue;
      asked.push(step);
    }
    return asked;
  }

  private async currentStep(ctx: C, def: AnyDialogue<C>, state: DialogueState) {
    return (await this.steps(ctx, def, state))[state.step];
  }

  /** The arguments of step functions and onFinish / onCancel. */
  private helpers(ctx: C, _state: Session, state: DialogueState): StepHelpers<any, C> {
    const t = this.app.t(ctx);
    return { ctx, session: this.app.loadedSession(ctx), locale: this.app.localeOf(ctx), t, params: state.params, answers: state.answers, nav: this.app.nav(ctx), app: this.app };
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

    const keyboard = this.inlineKeyboard(ctx, def, state, step);
    await this.sendTracked(ctx, session, state, { text, ...media, keyboard });
  }

  /** The prompt's inline buttons. `view`: what a widget shows now (a number, a calendar month). */
  private inlineKeyboard(ctx: C, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>, view = state.view): InlineKeyboardButton[][] {
    const keyboard: InlineKeyboardButton[][] = [];
    const texts = this.app.textsFor(ctx);
    const grid = (options: readonly { text: string; value: string }[], columns: number | undefined, label: (o: { text: string; value: string }) => string, kind: Kind) => {
      const perRow = Math.max(1, columns ?? 1);
      for (let i = 0; i < options.length; i += perRow) {
        keyboard.push(options.slice(i, i + perRow).map((o) => this.button(ctx, state, step, label(o), kind, o.value)));
      }
    };
    if (step.type === 'choice') grid(step.options, step.columns, (o) => o.text, Kind.Choice);
    if (step.type === 'multiChoice') {
      const selected = this.selection(state, step);
      grid(step.options, step.columns, (o) => (selected.includes(o.value) ? `✅ ${o.text}` : o.text), Kind.Toggle);
      keyboard.push([this.button(ctx, state, step, texts.done, Kind.Done)]);
    }
    if (step.type === 'number') {
      const start = step.initial ?? step.min ?? 0;
      const value = view !== undefined ? Number(view) : Math.min(step.max ?? Infinity, Math.max(step.min ?? -Infinity, start));
      const move = (label: string, delta: number | undefined) => {
        if (!delta) return [];
        const next = addStep(value, delta);
        // At the limit the button stays, greyed out, so the row doesn't jump around.
        return [numberInRange(next, step) ? this.button(ctx, state, step, label, Kind.Set, String(next)) : disabled(label)];
      };
      keyboard.push([
        ...move('⏪', step.bigStep && -step.bigStep),
        ...move('➖', -(step.step ?? 1)),
        disabled(step.format ? step.format(value) : String(value)),
        ...move('➕', step.step ?? 1),
        ...move('⏩', step.bigStep),
      ]);
      keyboard.push([this.button(ctx, state, step, texts.done, Kind.Done, String(value))]);
    }
    if (step.type === 'date') {
      const { min, max, initial, timeZone } = this.dateBounds(ctx, state, step);
      const month = view ?? startMonth(initial, min, max, timeZone);
      const cal = calendar(month, { min, max, weekStartsOn: step.weekStartsOn, locale: this.app.localeOf(ctx) });
      keyboard.push([
        cal.previous ? this.button(ctx, state, step, '‹', Kind.Page, cal.previous) : disabled(' '),
        disabled(cal.title),
        cal.next ? this.button(ctx, state, step, '›', Kind.Page, cal.next) : disabled(' '),
      ]);
      keyboard.push(cal.weekdays.map(disabled));
      for (const week of cal.weeks) {
        // Days out of range keep their number, greyed out: the month stays readable.
        keyboard.push(week.map((day) => (!day ? disabled(' ') : day.enabled ? this.button(ctx, state, step, String(day.day), Kind.Pick, day.iso) : disabled(String(day.day)))));
      }
    }
    if (step.actions?.length) {
      keyboard.push(step.actions.map((a) => this.button(ctx, state, step, a.text, Kind.Action, a.id)));
    }
    // A collect step shown again (after an error) keeps its Done button for what was sent so far.
    const collected = step.type === 'collect' && state.collected ? state.collected.texts.length + state.collected.files.length : 0;
    if (collected > 0) keyboard.push([this.button(ctx, state, step, texts.done, Kind.Done)]);
    keyboard.push(this.controls(ctx, def, state, step));
    return keyboard;
  }

  /**
   * A `date` step's limits as days, in its time zone (the step's, else
   * `dialogues.timeZone`, else the server's). Evaluated on every use, so
   * "from today" moves with the clock.
   */
  private dateBounds(ctx: C, state: DialogueState, step: Extract<AnyStep<C>, { type: 'date' }>) {
    const zone = typeof step.timeZone === 'function' ? step.timeZone(this.helpers(ctx, undefined as never, state)) : step.timeZone;
    const timeZone = zone ?? this.app.dialogueTimeZone;
    checkTimeZone(timeZone);
    const what = (field: string) => `Step "${step.id}": ${field}`;
    const min = resolveDate(step.min, timeZone, what('min'));
    const max = resolveDate(step.max, timeZone, what('max'));
    if (min && max && min > max) throw new EasyTGError(`Step "${step.id}": min (${min}) is after max (${max})`);
    return { min, max, initial: resolveDate(step.initial, timeZone, what('initial')), timeZone };
  }

  /** The options chosen so far in a `multiChoice` step (its `initial` ones at first). */
  private selection(state: DialogueState, step: Extract<AnyStep<C>, { type: 'multiChoice' }>): string[] {
    return (state.selected ??= step.initial ? step.options.map((o) => o.value).filter((v) => step.initial!.includes(v)) : []);
  }

  /** Redraw the pressed prompt's buttons in place (a toggle, a number, another month). */
  private async refresh(ctx: C, session: Session, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>, view?: string) {
    if (view !== undefined) state.view = view;
    const inline_keyboard = this.inlineKeyboard(ctx, def, state, step);
    this.save(session, state);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard } });
    } catch (error) {
      if (!String(error).includes('message is not modified')) throw error;
    }
  }

  private replyKeyboard(ctx: C, def: AnyDialogue<C>, state: DialogueState, step: AnyStep<C>): ReplyKeyboardMarkup {
    const texts = this.app.textsFor(ctx);
    const rows: KeyboardButton[][] = [];
    if (step.type === 'contact') rows.push([{ text: step.button ?? texts.shareContact, request_contact: true }]);
    if (step.type === 'location') rows.push([{ text: step.button ?? texts.shareLocation, request_location: true }]);
    if (step.type === 'webApp') rows.push([{ text: step.button ?? texts.openWebApp, web_app: { url: step.url } }]);
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
    return { text, callback_data: this.app.controlData(ctx, { r: state.run, s: stepKey(step.id), k: kind, v: value }) };
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
    if (delivery?.ephemeralSent?.length) state.ephemeralMessages = [...(state.ephemeralMessages ?? []), ...delivery.ephemeralSent];
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
    delete state.selected;
    delete state.view;
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
    this.app.setFlowSource(ctx, def.id);
    const finish = () => def.finishFn!(this.endArgs(ctx, session, state));
    // The prompt was just cleared: the placeholder is always a new message.
    const result = def.loadingOptions ? await this.app.withPlaceholder(ctx, def.loadingOptions, finish, true) : await finish();
    await this.app.showResult(ctx, result, 'send');
  }

  /** Delete tracked messages, optionally keeping one (e.g. the one being edited). */
  private async clear(ctx: C, state: DialogueState, keepMessageId?: number) {
    // Ephemeral prompts go with their own method; deleting one shows the message it replaced again.
    const ephemeral = state.ephemeralMessages ?? [];
    delete state.ephemeralMessages;
    for (const e of ephemeral) {
      await ctx.api.deleteEphemeralMessage(e.chatId, e.receiverUserId, e.id).catch((error: unknown) => this.app.logger.debug('Failed to delete an ephemeral prompt', error));
    }
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

/** Mini App data: JSON when it is JSON, else the string as sent. */
export function parseWebAppData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** A button Telegram shows greyed out, that sends nothing (Bot API 10.3). */
const disabled = (text: string): InlineKeyboardButton => ({ text, disabled: {} });

/**
 * A step's id in button data: short ids as they are, longer ones as a short
 * hash, so a calendar's 40-odd buttons stay within Telegram's 64 bytes
 * instead of being stored server-side.
 */
function stepKey(id: string): string {
  return id.length <= 8 ? id : `~${toBase64Url(sha256(id)).slice(0, 7)}`;
}

function randomRun() {
  return Math.random().toString(36).slice(2, 8);
}
