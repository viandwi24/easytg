import type { Bot, Context } from 'grammy';
import { assertValidId } from './callback';
import { EasyTGError, InvalidParamsError } from './errors';
import { isStandardSchema, validateSchema, type StandardSchemaV1 } from './schema';
import type { EasyTG } from './engine';
import type { Translate } from './i18n';
import type { AnswersOf, AnswersSoFar, Auto, ResolveAnswers } from './answers';
import type {
  Awaitable,
  DialogueEndArgs,
  DialogueStep,
  LoadingOptions,
  Middleware,
  Params,
  ParamsShape,
  RenderArgs,
  RenderResult,
  TextInputArgs,
  TextInputOptions,
} from './types';

/**
 * A page. Pages can link to each other in any order (even in cycles) and stay
 * fully type-checked:
 *
 *   const home = page('home').render(({ nav }) => ({
 *     keyboard: [[nav.button('Order #1', order, { id: '1' })]],
 *   }));
 *   const order = page<{ id: string }>('order').render(({ params, nav }) => ({
 *     text: `Order ${params.id}`,
 *     keyboard: [[nav.button('Back', home)]],
 *   }));
 *
 * (Keep it `page(id).render(fn)`: an options-object form like
 * `definePage({ id, render })` makes TypeScript give up on pages that
 * reference each other.)
 */
export class Page<P = Params, C extends Context = Context, R = P> {
  readonly kind = 'page' as const;
  /** Phantom field carrying the params type (as passed to buttons and links). */
  declare readonly __params?: P;

  /** @internal */ renderFn?: (args: RenderArgs<R, C>) => Awaitable<RenderResult>;
  /** @internal */ parseFn?: (raw: P) => Awaitable<R>;
  /** @internal */ readonly middlewares: Middleware<C>[] = [];
  /** @internal */ deepLinkEnabled = false;
  /** @internal */ textFn?: (args: TextInputArgs<R, C>) => Awaitable<RenderResult>;
  /** @internal */ loadingOptions?: LoadingOptions | false;
  /** @internal */ textOptions: TextInputOptions = {};

  /** @internal Use `page(id)`. */
  constructor(readonly id: string) {
    assertValidId('page', id);
  }

  /** Add middlewares that run (after global ones) before this page renders. */
  use(...middlewares: Middleware<C>[]): this {
    this.middlewares.push(...middlewares);
    return this;
  }

  /**
   * Allow opening this page from a deep link (`nav.deepLink` / `app.deepLink`).
   * Anyone can craft a deep link, so treat its params as untrusted input.
   */
  allowDeepLink(enabled = true): this {
    this.deepLinkEnabled = enabled;
    return this;
  }

  /**
   * Validate and convert the incoming params before render, with a function
   * (throw, e.g. `InvalidParamsError`, to reject) or a Standard Schema (zod,
   * valibot, arktype, …). Rejected params show "page not found" on button
   * presses. Buttons and links keep using the raw (string) params.
   *
   *   page<{ id: string }>('episode')
   *     .params((raw) => ({ id: toInt(raw.id) }))
   *     .render(({ params }) => …)   // params.id: number
   *
   *   page<{ id: string }>('episode')
   *     .params(z.object({ id: z.coerce.number().int() }))
   */
  params<R2>(schema: StandardSchemaV1<any, R2>): Page<P, C, R2>;
  params<R2>(parse: (raw: P) => Awaitable<R2>): Page<P, C, R2>;
  params<R2>(parse: ((raw: P) => Awaitable<R2>) | StandardSchemaV1<any, R2>): Page<P, C, R2> {
    const self = this as unknown as Page<P, C, R2>;
    if (isStandardSchema(parse)) {
      self.parseFn = async (raw) => {
        const result = await validateSchema(parse, raw);
        if (!result.ok) throw new InvalidParamsError(`Invalid params for "${this.id}": ${result.message}`);
        return result.value;
      };
    } else {
      self.parseFn = parse;
    }
    return self;
  }

  /**
   * What users see while this page renders slowly (an AI answer, a report):
   * a placeholder text, a "typing…" action or a toast, shown only after
   * `afterMs` (default 500). A string is a placeholder text; `true` is
   * "typing…"; `false` turns off the app's default `loading`.
   *
   *   page('answer').loading({ text: '⏳ Thinking…', action: 'typing' }).render(async () => …)
   */
  loading(options: LoadingOptions | string | boolean): this {
    this.loadingOptions = loadingOptions(options);
    return this;
  }

  render(fn: (args: RenderArgs<R, C>) => Awaitable<RenderResult>): this {
    if (this.renderFn) throw new EasyTGError(`Page "${this.id}" already has a render`);
    this.renderFn = fn;
    return this;
  }

  /**
   * Handle text the user sends while this page is the last one shown to them,
   * e.g. a search box. Commands, menu buttons and dialogues go first. Works in
   * private chats, and in groups for replies to the page's message. The result
   * is shown like a render (by default as a new message):
   *
   *   page<{ q?: string }>('search')
   *     .render(({ params }) => ({ text: params.q ? results(params.q) : 'Type a product name' }))
   *     .onText(({ text, nav }) => nav.redirect(search, { q: text }))
   */
  onText(fn: (args: TextInputArgs<R, C>) => Awaitable<RenderResult>, options: TextInputOptions = {}): this {
    if (this.textFn) throw new EasyTGError(`Page "${this.id}" already has onText`);
    this.textFn = fn;
    this.textOptions = options;
    return this;
  }
}

/**
 * A dialogue handle: a multi-step form. `A` types the answers given to
 * `onFinish`, `P` the params it is started with.
 *
 *   export const signup = dialogue<{ name: string }>('signup');
 *   signup
 *     .steps([{ id: 'name', type: 'text', text: 'Your name?' }])
 *     .onFinish(({ answers }) => ({ text: `Welcome ${answers.name}` }));
 */
export class Dialogue<A = Auto, P = Params, C extends Context = Context> {
  readonly kind = 'dialogue' as const;
  declare readonly __params?: P;

  /** @internal */ stepsDef?:
    | readonly DialogueStep<P, C>[]
    | ((args: StepsArgs<A, P, C>) => Awaitable<readonly DialogueStep<P, C>[]>);
  /** @internal */ finishFn?: (args: DialogueEndArgs<AnswersSoFar<A>, P, C>) => Awaitable<RenderResult>;
  /** @internal */ cancelFn?: (args: DialogueEndArgs<Partial<AnswersSoFar<A>>, P, C>) => Awaitable<RenderResult>;
  /** @internal */ backEnabled = true;
  /** @internal */ timeoutMs?: number;
  /** @internal */ loadingOptions?: LoadingOptions | false;
  /** @internal */ deepLinkEnabled = false;
  /** @internal */ readonly middlewares: Middleware<C>[] = [];

  /** @internal Use `dialogue(id)`. */
  constructor(readonly id: string) {
    assertValidId('dialogue', id);
  }

  /** Add middlewares that run (after global ones) before this dialogue starts, e.g. access checks. */
  use(...middlewares: Middleware<C>[]): this {
    this.middlewares.push(...middlewares);
    return this;
  }

  /**
   * The steps, or a function of the answers so far (re-evaluated after every
   * answer). The answers `onFinish` gets are typed from the steps: ids, choice
   * values, schema outputs, and optional answers for steps with `when`.
   * (With `dialogue<{ … }>()`, the declared answers are used instead.)
   */
  steps<const T extends readonly DialogueStep<P, C>[]>(
    steps: T | ((args: StepsArgs<A, P, C>) => Awaitable<T>),
  ): Dialogue<ResolveAnswers<A, AnswersOf<T>>, P, C> {
    if (this.stepsDef) throw new EasyTGError(`Dialogue "${this.id}" already has steps`);
    this.stepsDef = steps as never;
    return this as never;
  }

  /** Called after the last step; the result is sent as a new message. The dialogue state is then removed. */
  onFinish(fn: (args: DialogueEndArgs<AnswersSoFar<A>, P, C>) => Awaitable<RenderResult>): this {
    if (this.finishFn) throw new EasyTGError(`Dialogue "${this.id}" already has onFinish`);
    this.finishFn = fn;
    return this;
  }

  /**
   * Called when the user cancels. From the Cancel button, the result replaces
   * the prompt (nothing = prompt deleted). When cancelled by a /command or by
   * starting another dialogue, the result is ignored.
   */
  onCancel(fn: (args: DialogueEndArgs<Partial<AnswersSoFar<A>>, P, C>) => Awaitable<RenderResult>): this {
    if (this.cancelFn) throw new EasyTGError(`Dialogue "${this.id}" already has onCancel`);
    this.cancelFn = fn;
    return this;
  }

  /** Allow starting this dialogue from a deep link. Its params are untrusted input. */
  allowDeepLink(enabled = true): this {
    this.deepLinkEnabled = enabled;
    return this;
  }

  /**
   * End the dialogue when the user doesn't answer for `ms` (0 = never), like a
   * Cancel whose result isn't shown: `onCancel` runs and `dialogueCancel` has
   * `reason: 'timeout'`. Text sent after that goes to your own handlers.
   * Default: the `dialogues.timeoutMs` option.
   */
  timeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /** What users see while `onFinish` is slow (see `page.loading`). */
  loading(options: LoadingOptions | string | boolean): this {
    this.loadingOptions = loadingOptions(options);
    return this;
  }

  /** Show a Back button on steps after the first. Default true. */
  allowBack(enabled = true): this {
    this.backEnabled = enabled;
    return this;
  }
}

/** Arguments of a steps function. */
type StepsArgs<A, P, C> = { ctx: C; params: P; answers: Partial<AnswersSoFar<A>>; t: Translate };


/** `false` is stored as "none" (it overrides the app's default). */
function loadingOptions(options: LoadingOptions | string | boolean): LoadingOptions | false {
  if (options === true) return { action: 'typing' };
  if (options === false) return false;
  return typeof options === 'string' ? { text: options } : options;
}

/** Declare a page. See `Page`. */
export function page<P extends ParamsShape<P> = Params, C extends Context = Context>(id: string): Page<P, C> {
  return new Page<P, C>(id);
}

/** Declare a dialogue. See `Dialogue`. */
export function dialogue<A = Auto, P extends ParamsShape<P> = Params, C extends Context = Context>(
  id: string,
): Dialogue<A, P, C> {
  return new Dialogue<A, P, C>(id);
}

/**
 * `page` / `dialogue` / `task` bound to your custom context type:
 *
 *   export const { page, dialogue, task } = withContext<MyContext>();
 */
export function withContext<C extends Context>() {
  return {
    page: <P extends ParamsShape<P> = Params>(id: string) => new Page<P, C>(id),
    dialogue: <A = Auto, P extends ParamsShape<P> = Params>(id: string) => new Dialogue<A, P, C>(id),
    task: <P = undefined>(id: string) => new Task<P, C>(id),
  };
}

/** What a task handler receives. */
export interface TaskArgs<P = unknown, C extends Context = Context> {
  payload: P;
  /** The bot the task was scheduled for (see `app.startScheduler`). */
  bot: TaskBot;
  app: EasyTG<C>;
  /** Id (to cancel or replace it), run count (1 on the first run) and when it was due. */
  task: { id: string; attempts: number; dueAt: number };
}

/** The bot a task runs with: anything `app.sendTo` accepts. */
export type TaskBot = Pick<Bot<any>, 'api' | 'botInfo' | 'isInited' | 'init'>;

export interface TaskOptions {
  /** Runs before giving up on a failing task. Default: the scheduler's `maxAttempts` (5). */
  maxAttempts?: number;
  /** Wait before retry number `attempt` (1, 2, …), in ms. Default: the scheduler's `retryDelayMs`. */
  retryDelayMs?: (attempt: number) => number;
}

/**
 * A job that runs later, saved in storage so it survives restarts. `P` types
 * the payload (JSON-serializable).
 *
 *   const remind = task<{ userId: number; text: string }>('remind').run(async ({ payload, bot, app }) => {
 *     await bot.api.sendMessage(payload.userId, payload.text);
 *   });
 *   app.register(remind);
 *   await app.schedule(remind, { userId, text: 'Stand up!' }, { delayMs: 60 * 60_000 });
 */
export class Task<P = unknown, C extends Context = Context> {
  readonly kind = 'task' as const;
  declare readonly __payload?: P;

  /** @internal */ runFn?: (args: TaskArgs<P, C>) => Awaitable<void>;
  /** @internal */ options: TaskOptions = {};

  /** @internal Use `task(id)`. */
  constructor(readonly id: string) {
    assertValidId('task', id);
  }

  run(fn: (args: TaskArgs<P, C>) => Awaitable<void>, options: TaskOptions = {}): this {
    if (this.runFn) throw new EasyTGError(`Task "${this.id}" already has a handler`);
    this.runFn = fn;
    this.options = options;
    return this;
  }
}

/** Declare a scheduled task. See `Task`. */
export function task<P = undefined, C extends Context = Context>(id: string): Task<P, C> {
  return new Task<P, C>(id);
}
