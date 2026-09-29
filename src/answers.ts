/**
 * Types that read a dialogue's answers off its steps, so
 *
 *   dialogue('signup').steps([
 *     { id: 'name', type: 'text', text: 'Name?' },
 *     { id: 'plan', type: 'choice', text: 'Plan?', options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
 *   ])
 *
 * gets `answers: { name: string; plan: 'free' | 'pro' }` in `onFinish`, with no
 * type written by hand. Types only; nothing here runs.
 */
import type { SchemaOutput, StandardSchemaV1 } from './schema';
import type { Collected, DialogueContact, DialogueFile, DialogueLocation } from './types';

declare const AUTO: unique symbol;
/**
 * "Infer the answers from the steps": the default answers type of
 * `dialogue()`. Pass it explicitly to type only the params:
 * `dialogue<Auto, { ref: string }>('signup')`.
 */
export type Auto = typeof AUTO;

/** The answers type before `.steps(...)` is known: anything goes. */
export type AnswersSoFar<A> = [A] extends [Auto] ? Record<string, any> : A;

/** The answer one step produces. */
export type AnswerOf<S> = S extends { type: 'text'; schema: infer Sc extends StandardSchemaV1 }
  ? SchemaOutput<Sc>
  : S extends { type: 'text' }
    ? string
    : S extends { type: 'choice'; options: readonly (infer O)[] }
      ? O extends { value: infer V }
        ? V
        : never
      : S extends { type: 'file' }
        ? DialogueFile
        : S extends { type: 'contact' }
          ? DialogueContact
          : S extends { type: 'location' }
            ? DialogueLocation
            : S extends { type: 'collect' }
              ? Collected
              : S extends { type: 'webApp'; schema: infer Sc extends StandardSchemaV1 }
                ? SchemaOutput<Sc>
                : S extends { type: 'webApp' }
                  ? unknown
                  : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Answers of one list of steps; steps with `when` may be skipped, so their answers are optional. */
type AnswersOfList<T extends readonly { id: string }[]> = string extends T[number]['id']
  ? Record<string, any> // ids that aren't literals (steps built in a loop): untyped
  : Simplify<
      { [S in T[number] as S extends { when: unknown } ? never : S['id']]: AnswerOf<S> } & {
        [S in T[number] as S extends { when: unknown } ? S['id'] : never]?: AnswerOf<S>;
      }
    >;

type AllKeys<U> = U extends unknown ? keyof U : never;
type ValueOf<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type OptionalSomewhere<U, All> = U extends unknown ? Exclude<All, RequiredKeys<U>> : never;
/** Several possible step lists (a steps function with branches): keys in every one stay required. */
type Merge<U, All extends PropertyKey = AllKeys<U>, Opt extends PropertyKey = OptionalSomewhere<U, All>> = Simplify<
  { [K in Exclude<All, Opt>]: ValueOf<U, K> } & { [K in Opt]?: Exclude<ValueOf<U, K>, undefined> }
>;

/** The answers of a dialogue with these steps (a union of step lists for a steps function). */
export type AnswersOf<T extends readonly { id: string }[]> = Merge<T extends unknown ? AnswersOfList<T> : never>;

/** The declared answers, or the ones inferred from the steps. */
export type ResolveAnswers<A, Inferred> = [A] extends [Auto] ? Inferred : A;
