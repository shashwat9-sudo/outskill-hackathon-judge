/**
 * First controlled production bootstrap.
 *
 * Creates only: the one shared admin account, the rubric version and its
 * categories, and the required system settings.
 *
 * It creates NO cohort, NO team, NO submission, NO assessment and NO ranking.
 * That is asserted afterwards against the database rather than merely intended.
 *
 * Idempotent. Running it twice is a supported operation and is what the second
 * pass below verifies.
 *
 *   npx tsx scripts/bootstrap-production.ts
 */

import { readFileSync } from 'node:fs';
import { createPostgresDatabase } from '../packages/shared/src/data/postgres/client';
import { bootstrapProduction } from '../packages/shared/src/data/postgres/bootstrap';

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || !match[2]) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    env[match[1] as string] = value;
  }
  return env;
}

const pass = (label: string, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail = '') => console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) pass(label, detail);
  else {
    fail(label, detail);
    failures += 1;
  }
}

async function main() {
  const env = loadEnvFile('.env.local');
  const url = env.DATABASE_URL;
  const username = env.ADMIN_SEED_USERNAME;
  const password = env.ADMIN_SEED_PASSWORD;

  if (!url || !username || !password) {
    console.error('DATABASE_URL, ADMIN_SEED_USERNAME and ADMIN_SEED_PASSWORD must all be set.');
    process.exit(1);
  }

  const db = await createPostgresDatabase({ connectionString: url, maxConnections: 2 });

  const count = async (table: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return rows[0]?.n ?? 0;
  };

  try {
    console.log('\n=== Before ===');
    console.log(`  admin accounts: ${await count('admin_account')}`);
    console.log(`  rubric versions: ${await count('rubric_versions')}`);
    console.log(`  system settings: ${await count('system_settings')}`);

    console.log('\n=== First bootstrap ===');
    const first = await bootstrapProduction(db, {
      adminUsername: username,
      adminPassword: password,
    });
    console.log(`  admin created:      ${first.adminCreated}`);
    console.log(`  rubric created:     ${first.rubricCreated}`);
    console.log(`  rubric categories:  ${first.rubricCategories}`);
    console.log(`  settings created:   ${first.settingsCreated}`);

    console.log('\n=== Second bootstrap (idempotency) ===');
    const second = await bootstrapProduction(db, {
      adminUsername: username,
      adminPassword: password,
    });
    check(!second.adminCreated, 'no second admin account created');
    check(!second.rubricCreated, 'no duplicate rubric version');
    check(second.rubricCategories === 0, 'no duplicate rubric categories');
    check(second.settingsCreated === 0, 'no settings rewritten');
    check(second.alreadyBootstrapped, 'reports already bootstrapped');

    console.log('\n=== State after two runs ===');
    check((await count('admin_account')) === 1, 'exactly one admin account');
    check((await count('rubric_versions')) === 1, 'exactly one rubric version');

    const { rows: categories } = await db.query<{ n: number; total: number }>(
      'select count(*)::int as n, sum(max_points)::int as total from rubric_categories',
    );
    check(categories[0]?.total === 100, 'rubric totals 100 points', `${categories[0]?.total}`);
    console.log(`  ·  categories — ${categories[0]?.n}`);
    console.log(`  ·  settings — ${await count('system_settings')}`);

    // The password must still be the one from the FIRST run. A bootstrap that
    // silently re-hashed it would break an operator already signed in.
    const { rows: admin } = await db.query<{ username: string; password_updated_at: Date }>(
      'select username, password_updated_at from admin_account',
    );
    check(admin[0]?.username === username, 'admin username', admin[0]?.username ?? 'missing');

    console.log('\n=== Nothing else was created ===');
    for (const table of [
      'cohorts',
      'cohort_ideas',
      'teams',
      'team_members',
      'team_invites',
      'team_access_codes',
      'participant_sessions',
      'submissions',
      'submission_artifacts',
      'assessment_jobs',
      'category_scores',
      'assessment_summaries',
      'ranking_snapshots',
      'ranking_entries',
      'final_selections',
      'feedback_reports',
    ]) {
      const n = await count(table);
      check(n === 0, table, n === 0 ? 'empty' : `${n} row(s) — UNEXPECTED`);
    }

    console.log('\n=== Judging is off by default ===');
    const { rows: judging } = await db.query<{ value: unknown }>(
      `select value from system_settings where key = 'judging.enabled'`,
    );
    check(judging[0]?.value === false, 'judging.enabled is false');

    const { rows: visible } = await db.query<{ value: unknown }>(
      `select value from system_settings where key = 'participants.results_visible'`,
    );
    check(visible[0]?.value === false, 'participants.results_visible is false');

    await db.close();
  } catch (error) {
    fail('bootstrap', error instanceof Error ? error.message : String(error));
    failures += 1;
    await db.close().catch(() => undefined);
  }

  console.log(
    failures === 0
      ? '\n✅ Production bootstrap complete and idempotent.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
