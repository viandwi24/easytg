import type { Context } from 'grammy';
import { assertValidId } from './callback';
import { EasyTGError } from './errors';
import type {
  Awaitable,
  DialogueEndArgs,
  DialogueStep,
  Middleware,
  Params,
  ParamsShape,
  RenderArgs,
  RenderResult,
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
  /** @internal */ parseFn?: (raw: P) => R;
  /** @internal */ readonly middlewares: Middleware<C>[] = [];
  /** @internal */ deepLinkEnabled = false;

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
   * Validate and convert the incoming params before render. Throw (e.g.
   * `InvalidParamsError`) to reject them: button presses then show "page not
   * found". Buttons and links keep using the raw (string) params.
   *
   *   page<{ id: string }>('episode')
   *     .params((raw) => ({ id: toInt(raw.id) }))
   *     .render(({ params }) => …)   // params.id: number
   */
  params<R2>(parse: (raw: P) => R2): Page<P, C, R2> {
    const self = this as unknown as Page<P, C, R2>;
    self.parseFn = parse;
    return self;
  }

  render(fn: (args: RenderArgs<R, C>) => Awaitable<RenderResult>): this {
    if (this.renderFn) throw new EasyTGError(`Page "${this.id}" already has a render`);
    this.renderFn = fn;
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
export class Dialogue<A = Record<string, any>, P = Params, C extends Context = Context> {
  readonly kind = 'dialogue' as const;
  declare readonly __params?: P;

  /** @internal */ stepsDef?:
    | DialogueStep<P, C>[]
    | ((args: { ctx: C; params: P; answers: Partial<A> }) => Awaitable<DialogueStep<P, C>[]>);
  /** @internal */ finishFn?: (args: DialogueEndArgs<A, P, C>) => Awaitable<RenderResult>;
  /** @internal */ cancelFn?: (args: DialogueEndArgs<Partial<A>, P, C>) => Awaitable<RenderResult>;
  /** @internal */ backEnabled = true;
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

  /** The steps, or a function of the answers so far (re-evaluated after every answer). */
  steps(
    steps:
      | DialogueStep<P, C>[]
      | ((args: { ctx: C; params: P; answers: Partial<A> }) => Awaitable<DialogueStep<P, C>[]>),
  ): this {
    this.stepsDef = steps;
    return this;
  }

  /** Called after the last step; the result is sent as a new message. The dialogue state is then removed. */
  onFinish(fn: (args: DialogueEndArgs<A, P, C>) => Awaitable<RenderResult>): this {
    this.finishFn = fn;
    return this;
  }

  /**
   * Called when the user cancels. From the Cancel button, the result replaces
   * the prompt (nothing = prompt deleted). When cancelled by a /command or by
   * starting another dialogue, the result is ignored.
   */
  onCancel(fn: (args: DialogueEndArgs<Partial<A>, P, C>) => Awaitable<RenderResult>): this {
    this.cancelFn = fn;
    return this;
  }

  /** Allow starting this dialogue from a deep link. Its params are untrusted input. */
  allowDeepLink(enabled = true): this {
    this.deepLinkEnabled = enabled;
    return this;
  }

  /** Show a Back button on steps after the first. Default true. */
  allowBack(enabled = true): this {
    this.backEnabled = enabled;
    return this;
  }
}

/** Declare a page. See `Page`. */
export function page<P extends ParamsShape<P> = Params, C extends Context = Context>(id: string): Page<P, C> {
  return new Page<P, C>(id);
}

/** Declare a dialogue. See `Dialogue`. */
export function dialogue<A = Record<string, any>, P extends ParamsShape<P> = Params, C extends Context = Context>(
  id: string,
): Dialogue<A, P, C> {
  return new Dialogue<A, P, C>(id);
}

/**
 * `page` / `dialogue` bound to your custom context type:
 *
 *   export const { page, dialogue } = withContext<MyContext>();
 */
export function withContext<C extends Context>() {
  return {
    page: <P extends ParamsShape<P> = Params>(id: string) => new Page<P, C>(id),
    dialogue: <A = Record<string, any>, P extends ParamsShape<P> = Params>(id: string) => new Dialogue<A, P, C>(id),
  };
}
