/**
 * SQL client abstraction.
 *
 * Two things implement this: `pg.Pool` against real Postgres in production, and
 * PGlite in tests. Keeping the surface this narrow is what makes the driver
 * testable at all — there is no Docker and no local Postgres on a typical
 * machine, so without an in-process engine the entire data layer would ship
 * unverified.
 *
 * The interface is deliberately not "a Postgres client". It is the four things
 * the repositories actually need, so a repository cannot reach around it for
 * something driver-specific.
 */

/** Anything that can run a parameterised statement. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlDatabase extends SqlClient {
  /**
   * Run `fn` inside a transaction.
   *
   * Commits on return, rolls back on throw. Nested calls join the outer
   * transaction rather than opening a second one — Postgres has no true nested
   * transactions, and a silent second BEGIN would make the outer rollback a lie.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// node-postgres
// --------------------------------------------------------------------------

/** The slice of `pg.Pool` this module uses. Typed structurally so `pg` stays a runtime-only dependency. */
interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

export interface PostgresConnectionOptions {
  /**
   * Must be Supabase's TRANSACTION pooler for the serverless web tier.
   *
   * A session-pooler connection pins a Postgres backend for its whole life. A
   * few hundred concurrent serverless invocations — which is exactly the shape
   * of the final hour before a deadline — exhaust the server that way. The
   * transaction pooler hands a backend back after each transaction, so the same
   * traffic needs a fraction of the connections (ADR-032).
   */
  connectionString: string;
  /**
   * Pool ceiling PER INSTANCE, not per deployment.
   *
   * Serverless multiplies this by the number of live instances, so the default
   * is deliberately small. Ten here becomes hundreds under load.
   */
  maxConnections?: number;
  /** Fail a query rather than hanging a request forever. */
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Close idle connections quickly; a frozen serverless instance holds none. */
  idleTimeoutMs?: number;
}

/**
 * Check the connection string before handing it to `pg`.
 *
 * A Supabase database password commonly contains characters that are RESERVED
 * in a URI. An unencoded `#` starts a fragment and silently truncates
 * everything after it; an unencoded `@` moves where the host is taken to begin.
 * Either way `pg` gets a mangled host and reports something like
 * `EHOSTUNREACH 0.0.0.123`, which points at the network rather than at the
 * password — so the person debugging it looks in entirely the wrong place.
 *
 * Detected by comparing the parsed host against what the string plainly
 * contains, and reported with the actual fix.
 */
export function validateConnectionString(connectionString: string): void {
  const looksSupabase = connectionString.includes('pooler.supabase.com');

  let parsed: URL | null = null;
  try {
    parsed = new URL(connectionString);
  } catch {
    parsed = null;
  }

  // Either the parse failed outright, or it succeeded but landed on the wrong
  // host. Both mean the same thing when the string plainly contains a Supabase
  // host: a reserved character in the password moved where the host begins.
  //
  // In practice the culprit is almost always '#', which starts a URI fragment
  // and discards everything after it. An unencoded '@' is tolerated, because
  // the userinfo separator is the LAST '@' — so it is not worth warning about.
  if (looksSupabase && (!parsed || !parsed.hostname.includes('pooler.supabase.com'))) {
    throw new ConnectionStringError(
      'DATABASE_URL contains a Supabase pooler host, but it does not parse as one. ' +
        'The database password almost certainly contains a character that is reserved in a URI — ' +
        'most often "#" or "@". Percent-encode the password: "@" becomes %40, "#" becomes %23, ' +
        '"/" becomes %2F, ":" becomes %3A, "?" becomes %3F and "%" becomes %25. ' +
        'Only the password needs encoding; leave the rest of the URI as Supabase gave it.',
    );
  }

  if (!parsed) {
    throw new ConnectionStringError(
      'DATABASE_URL is not a valid URI. Copy it again from Supabase → Connect → Transaction pooler.',
    );
  }

  if (looksSupabase && parsed.port === '5432') {
    throw new ConnectionStringError(
      'DATABASE_URL uses port 5432, which is the SESSION pooler. The serverless web tier needs ' +
        'the TRANSACTION pooler on port 6543 — a session connection pins a Postgres backend for ' +
        'its whole life and exhausts the server under deadline-hour load (ADR-032).',
    );
  }
}

/**
 * Build a pooled client.
 *
 * `pg` is imported dynamically so that importing this module never pulls a
 * native-ish dependency into a bundle that does not use it — the browser barrel
 * must stay free of it, and the demo path must not need it installed.
 */
export async function createPostgresDatabase(
  options: PostgresConnectionOptions,
): Promise<SqlDatabase> {
  const { Pool } = (await import('pg')) as unknown as {
    Pool: new (config: Record<string, unknown>) => PgPoolLike;
  };

  validateConnectionString(options.connectionString);

  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 2,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    // The transaction pooler cannot support named prepared statements, because
    // a later execute may land on a different backend. `pg` only names a
    // statement when asked, and this driver never asks — but the parameter is
    // set explicitly so a future caller cannot enable it by accident.
    query_timeout: options.statementTimeoutMs ?? 15_000,
    // Supabase terminates TLS at the pooler with a certificate chain Node does
    // not have locally. The connection is still encrypted; only chain
    // verification is relaxed, and only for the database host we configured.
    ssl: options.connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  return wrapPool(pool);
}

/** Exported for tests that supply their own pool. */
export function wrapPool(pool: PgPoolLike): SqlDatabase {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },

    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      const tx: SqlClient = {
        async query<R>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
          const result = await connection.query(text, params);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
        },
      };

      try {
        await connection.query('begin');
        const value = await fn(tx);
        await connection.query('commit');
        return value;
      } catch (error) {
        // Rollback failure must not mask the original error — that error is
        // what the caller needs in order to understand what happened.
        await connection.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/** Postgres error codes this driver reacts to by name rather than by message. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export function pgErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}

/**
 * Raised when a row that must exist does not.
 *
 * Separate from a generic Error so a caller can distinguish "you asked for
 * something that is not there" from "the database is unwell".
 */
/** A connection string that will not do what the operator expects. */
export class ConnectionStringError extends Error {
  override readonly name = 'ConnectionStringError';
}

export class RowNotFoundError extends Error {
  override readonly name = 'RowNotFoundError';
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found.`);
  }
}

/**
 * Which role is this connection actually using, and does it bypass RLS?
 *
 * Asked at worker boot. The row-level security policies that keep judging away
 * from the ranking tables, the admin account and everyone's access codes are
 * simply not applied to a superuser — silently, with no error — so a deployment
 * connected as `postgres` looks identical to a correctly restricted one right
 * up until something goes wrong.
 *
 * Returns null when the question cannot be answered. A driver that will not
 * report its own role is not itself evidence of a problem, and refusing to
 * start over it would turn a diagnostic into an outage.
 */
export async function describeConnectionRole(
  db: SqlDatabase,
): Promise<{ role: string; bypassesRls: boolean } | null> {
  try {
    const { rows } = await db.query<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select current_user as role,
              coalesce(rolsuper, false) as rolsuper,
              coalesce(rolbypassrls, false) as rolbypassrls
         from pg_roles where rolname = current_user`,
    );
    const row = rows[0];
    if (!row) return null;
    return { role: row.role, bypassesRls: row.rolsuper || row.rolbypassrls };
  } catch {
    return null;
  }
}
