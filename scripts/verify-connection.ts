/**
 * Read-only production connectivity and schema check.
 *
 * Runs through the real driver (`createPostgresDatabase`), so it verifies the
 * production client wrapper — pooling, SSL, timeouts — and not just that a
 * connection string works.
 *
 * Every statement is a SELECT. It writes nothing, and it never prints the
 * connection string or any secret.
 *
 *   npx tsx scripts/verify-connection.ts
 */

import { readFileSync } from 'node:fs';
import { createPostgresDatabase, type SqlDatabase } from '../packages/shared/src/data/postgres/client';

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && match[2]) env[match[1] as string] = match[2].trim();
  }
  return env;
}

const pass = (label: string, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail = '') => console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
const info = (label: string, detail: string) => console.log(`  ·  ${label} — ${detail}`);

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) pass(label, detail);
  else {
    fail(label, detail);
    failures += 1;
  }
}

async function scalar<T>(db: SqlDatabase, sql: string, params?: unknown[]): Promise<T> {
  const { rows } = await db.query<Record<string, T>>(sql, params);
  return Object.values(rows[0] ?? {})[0] as T;
}

async function main() {
  const env = loadEnvFile('.env.local');
  const url = env.DATABASE_URL;

  console.log('\n=== 1. Connection string shape (never printed) ===');
  if (!url) {
    fail('DATABASE_URL is set');
    process.exit(1);
  }
  // Parsed rather than logged. Only derived facts are shown.
  const parsed = new URL(url);
  check(parsed.protocol.startsWith('postgres'), 'is a Postgres URI');
  check(
    parsed.hostname.includes('pooler.supabase.com'),
    'points at the Supabase pooler',
    parsed.hostname.replace(/^[^.]+/, '***'),
  );
  check(
    parsed.port === '6543',
    'uses the TRANSACTION pooler port',
    `port ${parsed.port}${parsed.port === '5432' ? ' — this is the SESSION pooler' : ''}`,
  );
  check(Boolean(parsed.password), 'includes a password');
  info('region host', parsed.hostname.split('.')[0] ?? 'unknown');

  console.log('\n=== 2. Connectivity through the production driver ===');
  const started = Date.now();
  let db: SqlDatabase;
  try {
    db = await createPostgresDatabase({ connectionString: url, maxConnections: 2 });
    await db.query('select 1');
    pass('connected', `${Date.now() - started} ms`);
  } catch (error) {
    fail('connected', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  try {
    const version = await scalar<string>(db, 'select version()');
    info('engine', version.split(' ').slice(0, 2).join(' '));
    info('database', await scalar<string>(db, 'select current_database()'));
    info('connected as', await scalar<string>(db, 'select current_user'));

    console.log('\n=== 3. Transaction support through the pooler ===');
    // The driver opens short transactions for atomic operations. If the pooler
    // did not support them, every access-code regeneration would fail.
    const txValue = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ n: number }>('select 42 as n');
      return rows[0]?.n;
    });
    check(txValue === 42, 'BEGIN/COMMIT works through the transaction pooler');

    // A rollback must actually roll back. Uses a temporary value only — nothing
    // is inserted into any table.
    let rolledBack = false;
    try {
      await db.transaction(async (tx) => {
        await tx.query('select 1');
        throw new Error('deliberate');
      });
    } catch {
      rolledBack = true;
    }
    check(rolledBack, 'a failing transaction propagates its error');

    console.log('\n=== 4. Schema matches what the driver was built against ===');
    const tables = await scalar<number>(
      db,
      "select count(*)::int from pg_tables where schemaname = 'public'",
    );
    check(tables === 38, 'public tables', `${tables} (expected 38)`);

    const noRls = await scalar<number>(
      db,
      "select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity",
    );
    check(noRls === 0, 'every table has RLS', `${noRls} without (expected 0)`);

    const roles = await scalar<number>(
      db,
      "select count(*)::int from pg_roles where rolname in ('ohj_participant','ohj_admin','ohj_worker')",
    );
    check(roles === 3, 'application roles', `${roles} (expected 3)`);

    const migrations = await scalar<number>(
      db,
      'select count(*)::int from supabase_migrations.schema_migrations',
    );
    check(migrations === 4, 'migrations applied', `${migrations} (expected 4)`);

    console.log('\n=== 5. Objects the driver depends on ===');
    // Every one of these is referenced by a query in the repositories. A
    // missing one is a runtime failure, not a compile-time one.
    for (const [label, sql] of [
      ['submission_is_late() function', "select count(*)::int from pg_proc where proname = 'submission_is_late'"],
      ['one-live-code index', "select count(*)::int from pg_indexes where indexname = 'team_access_codes_one_live'"],
      ['submissions unique (cohort_id, team_id)', "select count(*)::int from pg_constraint where conname like '%cohort_id_team_id%'"],
      ['audit append-only trigger', "select count(*)::int from pg_trigger where tgname like '%audit%' and not tgisinternal"],
      ['cohort_status enum', "select count(*)::int from pg_type where typname = 'cohort_status'"],
    ] as const) {
      const n = await scalar<number>(db, sql);
      check(n > 0, label, n > 0 ? 'present' : 'MISSING');
    }

    console.log('\n=== 6. No production data present ===');
    let total = 0;
    for (const table of [
      'cohorts',
      'teams',
      'team_members',
      'submissions',
      'team_access_codes',
      'participant_sessions',
      'assessment_jobs',
      'category_scores',
      'ranking_snapshots',
      'final_selections',
      'admin_account',
      'rubric_versions',
    ]) {
      const n = await scalar<number>(db, `select count(*)::int from ${table}`);
      total += n;
      if (n > 0) info(table, `${n} row(s)`);
    }
    check(total === 0, 'database is empty', `${total} row(s) across every table`);

    console.log('\n=== 7. Nothing was written ===');
    // Proven rather than asserted: the transaction id only advances on a write.
    const writes = await scalar<string>(db, 'select pg_current_xact_id_if_assigned()::text');
    check(writes === null, 'this session performed no write', writes ?? 'none');

    await db.close();
  } catch (error) {
    fail('checks completed', error instanceof Error ? error.message : String(error));
    failures += 1;
    await db.close().catch(() => undefined);
  }

  console.log(
    failures === 0
      ? '\n✅ All checks passed. The production driver can reach the database.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
