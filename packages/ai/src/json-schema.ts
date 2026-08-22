/**
 * Zod schemas as OpenAI Structured Outputs schemas.
 *
 * Structured Outputs constrains decoding, so a response cannot be the wrong
 * shape — the model is prevented from emitting one rather than asked not to.
 * That removes a whole class of retry: the three-attempts-then-fail loop that
 * exists here because a model once returned `deck: Required; written: Required`
 * three times running.
 *
 * It does not replace Zod. Strict mode supports a subset of JSON Schema and
 * silently ignores nothing — it *rejects* the keywords it does not support, so
 * `maxLength`, `minItems` and every `.refine()` in these schemas cannot be
 * expressed. Those are exactly the semantic bounds that matter: a 4000-word
 * rationale, an eleven-item evidence list, a fill value containing shell
 * metacharacters. So the shape is guaranteed by the provider and the meaning is
 * still enforced by Zod afterwards. Neither layer is redundant.
 *
 * Where a schema cannot be represented faithfully this returns null rather than
 * an approximation. An approximate schema would constrain the model to
 * something subtly different from what Zod will accept, which converts a clean
 * validation failure into an argument between two layers — and the caller has a
 * correct fallback available, so there is nothing to gain by guessing.
 */

import { z } from 'zod';

export interface JsonSchemaObject {
  type: string | string[];
  [key: string]: unknown;
}

/**
 * Convert a Zod schema, or return null if it cannot be represented exactly.
 *
 * Null is not a failure. It means "use the prompt-described path instead",
 * which is the route Gemini has always taken and which is proven in production.
 */
export function toStrictJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject | null {
  try {
    const converted = convert(schema, 0);
    // The root of a Structured Outputs schema must be an object.
    if (!converted || converted.type !== 'object') return null;
    return converted;
  } catch {
    return null;
  }
}

/**
 * Strict mode requires every property to appear in `required`, so an optional
 * field is expressed as one that may be null and must be present.
 *
 * The model therefore answers "I have nothing for this" explicitly instead of
 * omitting the key, and `stripNulls` turns that back into an absent key before
 * Zod sees it — because Zod's `.optional()` accepts a missing key and rejects
 * an explicit null, and changing the domain schemas to accept null would alter
 * what every other provider is allowed to send.
 */
function convert(schema: z.ZodTypeAny, depth: number): JsonSchemaObject | null {
  // Bounded because Structured Outputs itself bounds nesting, and because a
  // recursive schema would otherwise not terminate.
  if (depth > 8) return null;

  const { inner, nullable } = unwrap(schema);
  const base = convertInner(inner, depth);
  if (!base) return null;
  if (!nullable) return base;

  // `type` becomes a union with null rather than wrapping in anyOf: fewer
  // levels, and enums keep their `enum` keyword alongside.
  const types = Array.isArray(base.type) ? base.type : [base.type];
  return { ...base, type: [...types, 'null'] };
}

function convertInner(schema: z.ZodTypeAny, depth: number): JsonSchemaObject | null {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      const converted = convert(value, depth + 1);
      if (!converted) return null;
      properties[key] = converted;
    }
    return {
      type: 'object',
      properties,
      // Every key required, and nothing else permitted. Both are mandatory in
      // strict mode, and together they are what makes the shape a guarantee.
      required: Object.keys(shape),
      additionalProperties: false,
    };
  }

  if (schema instanceof z.ZodArray) {
    const items = convert(schema.element as z.ZodTypeAny, depth + 1);
    if (!items) return null;
    // `minItems`/`maxItems` are not supported in strict mode. Zod keeps them.
    return { type: 'array', items };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const variants = [...schema.options] as z.ZodTypeAny[];
    const converted: JsonSchemaObject[] = [];
    for (const variant of variants) {
      const one = convert(variant, depth + 1);
      if (!one) return null;
      converted.push(one);
    }
    return { type: 'object', anyOf: converted } as JsonSchemaObject;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(schema.options as string[])] };
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema.value;
    if (typeof value !== 'string') return null;
    return { type: 'string', enum: [value] };
  }

  if (schema instanceof z.ZodString) {
    // `maxLength`, `format` and every `.refine()` stay with Zod.
    return { type: 'string' };
  }

  if (schema instanceof z.ZodNumber) {
    return { type: schema.isInt ? 'integer' : 'number' };
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }

  /*
   * Anything else — records, plain unions, intersections, tuples, transforms —
   * is refused rather than approximated. This list grows when a schema needs
   * it and a test proves the conversion, never speculatively.
   */
  return null;
}

/**
 * Strip the wrappers that do not change the emitted shape, and report whether
 * the value may be absent.
 *
 * `.refine()` produces a `ZodEffects` whose predicate cannot be expressed in
 * JSON Schema at all. It is unwrapped rather than refused because the
 * constraint is not lost — Zod still applies it to the response — and refusing
 * would drop the whole test-plan schema over one predicate on a fill value.
 */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; nullable: boolean } {
  let current = schema;
  let nullable = false;

  for (let depth = 0; depth < 10; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      // A default means the model need not supply it, so it may answer null.
      nullable = true;
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { inner: current, nullable };
}

/**
 * Remove null-valued properties, recursively.
 *
 * The counterpart to expressing an optional field as a nullable required one.
 * Zod's `.optional()` accepts a missing key and rejects an explicit null, so
 * without this every plan step carrying `"nth": null` would fail validation and
 * retry until the attempt budget ran out.
 *
 * Safe as a blanket transform only because no schema in this system uses
 * `.nullable()`: null is never a meaningful value in any AI response here, so
 * removing it can never discard information. `json-schema.test.ts` asserts that
 * property directly against the real schemas, so a future `.nullable()` field
 * fails the suite rather than silently losing its value.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) continue;
    result[key] = stripNulls(entry);
  }
  return result;
}
