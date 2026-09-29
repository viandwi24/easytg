/**
 * Standard Schema (https://standardschema.dev): the common interface of zod,
 * valibot, arktype and others. easytg accepts any of them without depending
 * on one. The interface is copied here, as the spec recommends.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> };

/** The output type of a Standard Schema. */
export type SchemaOutput<S> = S extends StandardSchemaV1<any, infer O> ? O : never;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object' && value !== null && typeof (value as StandardSchemaV1)['~standard']?.validate === 'function';
}

/** Validate with a Standard Schema: the output, or the first issue's message. */
export async function validateSchema<O>(schema: StandardSchemaV1<unknown, O>, value: unknown): Promise<{ ok: true; value: O } | { ok: false; message: string }> {
  const result = await schema['~standard'].validate(value);
  if (!result.issues) return { ok: true, value: result.value };
  const issue = result.issues[0];
  const path = issue?.path?.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.');
  return { ok: false, message: issue ? (path ? `${path}: ${issue.message}` : issue.message) : 'Invalid value' };
}
