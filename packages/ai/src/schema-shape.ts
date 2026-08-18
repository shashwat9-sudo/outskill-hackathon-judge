/**
 * Describe a Zod schema to a model.
 *
 * Every AI call in this system validates against a schema, and the first real
 * provider run failed three times in a row with `deck: Required; written:
 * Required; risks: Required` — because the prompt asked for "valid JSON
 * matching the required structure" and never said what that structure was.
 * The model had no way to know the field names.
 *
 * Generating the description from the schema itself, rather than writing it out
 * in each prompt, means the two cannot drift apart. A field added to a schema
 * appears in the prompt on the next call.
 *
 * This produces a compact shape sketch rather than JSON Schema. JSON Schema is
 * verbose enough to crowd out the actual instructions, and models follow a
 * worked example of the shape more reliably than a specification of it.
 */

import { z } from 'zod';

/** Render a schema as an annotated JSON-ish skeleton. */
export function describeSchema(schema: z.ZodTypeAny, indent = 0): string {
  const pad = '  '.repeat(indent);
  const inner = unwrap(schema);

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const lines = Object.entries(shape).map(([key, value]) => {
      const optional = isOptional(value) ? '?' : '';
      return `${pad}  "${key}"${optional}: ${describeSchema(value, indent + 1)}`;
    });
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }

  if (inner instanceof z.ZodArray) {
    const element = describeSchema(inner.element as z.ZodTypeAny, indent);
    return `[${element}]${arrayBounds(inner)}`;
  }

  if (inner instanceof z.ZodEnum) {
    return (inner.options as string[]).map((o) => JSON.stringify(o)).join(' | ');
  }

  if (inner instanceof z.ZodLiteral) {
    return JSON.stringify(inner.value);
  }

  /**
   * A discriminated union is where a model needs the most help, and it was
   * getting none: `ZodDiscriminatedUnion` is a separate class from `ZodUnion`,
   * so it fell through to the catch-all and rendered as `value`.
   *
   * The test-plan schema is one, and the first controlled judging run failed
   * three times because the model was asked for a shape nobody had described —
   * it guessed `target` as a string and omitted `label`.
   *
   * Rendered as alternatives rather than an abstract union, because a worked
   * example of each variant is what a model actually follows.
   */
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const variants = [...inner.options] as z.ZodTypeAny[];
    const pad = '  '.repeat(indent);
    return variants
      .map((variant) => describeSchema(variant, indent))
      .join(`\n${pad}// ---- or ----\n${pad}`);
  }

  if (inner instanceof z.ZodUnion) {
    const options = inner.options as z.ZodTypeAny[];
    return options.map((option) => describeSchema(option, indent)).join(' | ');
  }

  if (inner instanceof z.ZodString) return `string${stringBounds(inner)}`;
  if (inner instanceof z.ZodNumber) return `number${numberBounds(inner)}`;
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodNull) return 'null';

  if (inner instanceof z.ZodRecord) {
    return `{ "<key>": ${describeSchema(inner.valueSchema as z.ZodTypeAny, indent)} }`;
  }

  return 'value';
}

/**
 * The instruction block appended to every system prompt.
 *
 * States the shape and the two rules that matter most when a model is unsure:
 * do not add fields, and do not invent a value for something it could not
 * determine. A guessed score is worse than a refused one.
 */
export function schemaInstruction(schema: z.ZodTypeAny): string {
  return [
    'Return ONLY a JSON object with exactly this shape:',
    '',
    describeSchema(schema),
    '',
    'Rules for the response:',
    '- Every field marked without "?" is required. Include all of them.',
    '- Do not add fields that are not listed.',
    '- Do not wrap the JSON in prose, markdown or code fences.',
    '- If you could not determine something, say so in the relevant notes or',
    '  missing-evidence field. Do not invent a value to fill a gap.',
  ].join('\n');
}

// --------------------------------------------------------------------------

/** Strip the wrappers that do not change the shape a model must produce. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return current;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional();
}

function stringBounds(schema: z.ZodString): string {
  const max = schema.maxLength;
  return max === null ? '' : ` (max ${max} chars)`;
}

function numberBounds(schema: z.ZodNumber): string {
  const parts: string[] = [];
  if (schema.minValue !== null) parts.push(`min ${schema.minValue}`);
  if (schema.maxValue !== null) parts.push(`max ${schema.maxValue}`);
  if (schema.isInt) parts.push('integer');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function arrayBounds(schema: z.ZodArray<z.ZodTypeAny>): string {
  const def = schema._def as { maxLength?: { value: number } | null; minLength?: { value: number } | null };
  const parts: string[] = [];
  if (def.minLength) parts.push(`min ${def.minLength.value}`);
  if (def.maxLength) parts.push(`max ${def.maxLength.value}`);
  return parts.length > 0 ? ` (${parts.join(', ')} items)` : '';
}
