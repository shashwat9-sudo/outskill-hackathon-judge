/**
 * Row mapping.
 *
 * Postgres columns are snake_case; entities are camelCase. The translation is
 * done here, once, rather than by writing `select x as "camelName"` in a hundred
 * queries — an aliased select is easy to get subtly wrong and impossible to
 * check in one place.
 *
 * Mapping is deliberately SHALLOW. Column names are transformed; values are
 * not. A `jsonb` column holding `{ "must_have_workflow": ... }` keeps its keys
 * exactly as stored, because those are participant data, not column names.
 */

export type Row = Record<string, unknown>;

const camelCache = new Map<string, string>();

export function toCamel(key: string): string {
  const cached = camelCache.get(key);
  if (cached) return cached;
  const value = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  camelCache.set(key, value);
  return value;
}

const snakeCache = new Map<string, string>();

export function toSnake(key: string): string {
  const cached = snakeCache.get(key);
  if (cached) return cached;
  const value = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  snakeCache.set(key, value);
  return value;
}

/** Map one row's keys to camelCase. Values pass through untouched. */
export function mapRow<T>(row: Row): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out as T;
}

export function mapRows<T>(rows: Row[]): T[] {
  return rows.map((row) => mapRow<T>(row));
}

/** Map a row that may be absent. */
export function mapMaybe<T>(rows: Row[]): T | null {
  return rows.length > 0 ? mapRow<T>(rows[0] as Row) : null;
}

// --------------------------------------------------------------------------
// Value coercion
// --------------------------------------------------------------------------

/**
 * `pg` returns `bigint` and `numeric` as strings to avoid silent precision
 * loss. Counts and scores are small enough that a number is correct, but the
 * conversion has to be explicit or a score becomes `"12"` and sorts as text.
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date column that the schema declares `not null`. */
export function requireDate(value: unknown): Date {
  const d = toDate(value);
  if (!d) throw new Error('Expected a timestamp but the column was null.');
  return d;
}

// --------------------------------------------------------------------------
// Statement building
// --------------------------------------------------------------------------

/**
 * Build the column list, placeholders and values for an INSERT.
 *
 * Keys are converted to snake_case and values are passed as parameters — there
 * is no path here that concatenates a value into SQL.
 */
export function buildInsert(data: Record<string, unknown>): {
  columns: string;
  placeholders: string;
  values: unknown[];
} {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  return {
    columns: entries.map(([k]) => toSnake(k)).join(', '),
    placeholders: entries.map((_, i) => `$${i + 1}`).join(', '),
    values: entries.map(([, v]) => v),
  };
}

/**
 * Build a SET clause for an UPDATE.
 *
 * `startIndex` lets the caller reserve parameters for the WHERE clause. Returns
 * null when there is nothing to update, so a caller can skip the statement
 * rather than emitting `set` with no assignments.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  startIndex = 1,
): { clause: string; values: unknown[] } | null {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  return {
    clause: entries.map(([k], i) => `${toSnake(k)} = $${startIndex + i}`).join(', '),
    values: entries.map(([, v]) => v),
  };
}

/**
 * Serialise a value for a `jsonb` column.
 *
 * `pg` sends a JS object as a Postgres composite unless it is stringified
 * first, which fails in a way that reads like a type error rather than a
 * serialisation one.
 */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Read a `jsonb` column that may arrive as an object or as text. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}


/**
 * Map a row whose `bigint` columns must arrive as numbers.
 *
 * `pg` returns `bigint` as a STRING, deliberately — 2^53 is not far away and
 * silent precision loss would be worse than an inconvenient type. But the
 * domain types declare `byteSize: number`, so without an explicit conversion
 * the value is a string wearing a number's type.
 *
 * That is not cosmetic. `"9" > "10"` is true, so any size comparison — an upload
 * ceiling, a "largest deck" sort, a quota check — silently gives the wrong
 * answer, and only for certain pairs of values. Found during the acceptance run
 * when a byte count came back as `"64476"`.
 */
export function mapRowWithNumbers<T>(row: Row, numericColumns: readonly string[]): T {
  const mapped = mapRow<T>(row) as Record<string, unknown>;
  for (const column of numericColumns) {
    const key = toCamel(column);
    if (mapped[key] !== null && mapped[key] !== undefined) {
      mapped[key] = toNumber(mapped[key]);
    }
  }
  return mapped as T;
}

export function mapRowsWithNumbers<T>(rows: Row[], numericColumns: readonly string[]): T[] {
  return rows.map((row) => mapRowWithNumbers<T>(row, numericColumns));
}

/** `bigint` columns on the artifact and resource tables. */
export const ARTIFACT_NUMERIC_COLUMNS = ['byte_size'] as const;
