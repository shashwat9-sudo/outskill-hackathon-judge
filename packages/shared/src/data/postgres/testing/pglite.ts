/**
 * In-process Postgres for tests.
 *
 * PGlite is a real Postgres engine compiled to WebAssembly. It runs the actual
 * migration files — not a hand-maintained test schema — so a column this driver
 * gets wrong fails here rather than in production.
 *
 * This exists because there is no other way to test the driver on a typical
 * machine: Supabase's CLI needs Docker for a local database, and the only real
 * Postgres otherwise available is the production one. Shipping the data layer
 * unverified was the alternative.
 *
 * Test-only. Nothing in the production path imports it.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResult, SqlClient, SqlDatabase } from '../client';

/** Migrations that describe the application schema. */
const SCHEMA_MIGRATIONS = [
  '0001_schema',
  '0002_rls',
  '0004_production_entry',
  '0005_operations_hardening',
  '0006_worker_least_privilege',
  '0007_cohort_synthetic_marker',
  '0008_browser_run_attempts',
] as const;

/**
 * `0003_storage.sql` is deliberately absent.
 *
 * It targets Supabase's `storage` schema, which is part of Supabase rather than
 * Postgres and does not exist in a bare engine. Storage is verified against real
 * Supabase instead — see `scripts/verify-remote-schema.sql`.
 */

function migrationsDir(): string {
  // packages/shared/src/data/postgres/testing → repository root
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../supabase/migrations');
}

/**
 * Adjust a migration for the bare engine.
 *
 * `gen_random_uuid()` has been core since Postgres 13, so the pgcrypto
 * extension line is the only thing a non-Supabase engine cannot satisfy.
 * Removing it changes no behaviour — every call site still resolves.
 */
function forBareEngine(sql: string): string {
  return sql.replace(/create extension if not exists "pgcrypto";/g, '');
}

export interface PgliteHandle extends SqlDatabase {
  /** Delete every row while leaving the schema in place. Far faster than rebuilding. */
  truncateAll(): Promise<void>;
}

/** Boot an engine with the real schema applied. */
export async function createTestDatabase(): Promise<PgliteHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');

  const db = await PGlite.create({ extensions: { citext } });
  const dir = migrationsDir();

  for (const name of SCHEMA_MIGRATIONS) {
    const sql = await readFile(resolve(dir, `${name}.sql`), 'utf8');
    await db.exec(forBareEngine(sql));
  }

  const run = async <T>(text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const result = await db.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    query: run,

    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      // PGlite is single-connection, so the transaction runs on the same handle.
      // Correctness of BEGIN/COMMIT/ROLLBACK is unaffected; only concurrency is,
      // and a test asserting on concurrent transactions would be testing PGlite
      // rather than this driver.
      await db.exec('begin');
      try {
        const value = await fn({ query: run });
        await db.exec('commit');
        return value;
      } catch (error) {
        await db.exec('rollback').catch(() => undefined);
        throw error;
      }
    },

    async truncateAll() {
      const { rows } = await db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public'",
      );
      if (rows.length === 0) return;
      const names = rows.map((r) => `public.${r.tablename}`).join(', ');
      // `cascade` here follows foreign keys between the tables being emptied —
      // it is scoped to this list and cannot reach anything else.
      await db.exec(`truncate ${names} restart identity cascade`);
    },

    async close() {
      await db.close();
    },
  };
}
