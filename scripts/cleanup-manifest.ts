/**
 * What synthetic acceptance data exists, and what would remove it.
 *
 * READ-ONLY. This script deletes nothing and has no code path that could.
 * It exists so a purge can be approved on evidence rather than on a guess.
 */
import { readFileSync } from 'node:fs';
import { createPostgresDataStore } from '../packages/shared/src/data/postgres/store';
import { assessCohortDeletion } from '../packages/shared/src/domain/cohort-deletion';

async function main() {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key) process.env[key] ??= (value ?? '').trim();
  }
  const store = await createPostgresDataStore({
    databaseUrl: process.env.DATABASE_URL!, supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!, sessionSecret: process.env.ADMIN_SESSION_SECRET!,
    credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY!,
    credentialKeyVersion: Number(process.env.CREDENTIAL_KEY_VERSION ?? 1), maxConnections: 2,
  });

  const cohorts = await store.cohorts.listCohorts();
  console.log('COHORTS');
  for (const c of cohorts) console.log(`  "${c.name}" [${c.code}] status=${c.status}`);

  for (const cohort of cohorts) {
    const deps = await store.cohorts.getCohortDependencies(cohort.id);
    const verdict = assessCohortDeletion(cohort.name, deps);

    console.log(`\nCOHORT: ${cohort.name}`);
    console.log(`  Danger Zone verdict: ${verdict.verdict.toUpperCase()}`);
    console.log('  holds:');
    for (const [k, v] of Object.entries(deps)) if (v > 0) console.log(`    ${k}: ${v}`);
    if (verdict.blockers.length) {
      console.log('  REFUSED because:');
      for (const b of verdict.blockers) console.log(`    - ${b}`);
    }
    console.log('  would remove:');
    for (const r of verdict.willRemove) console.log(`    ${r.label}: ${r.count}`);
    console.log('  would preserve:');
    for (const r of verdict.willPreserve) console.log(`    ${r.label}: ${r.count}`);

    // Storage objects are not database rows and are never cascaded.
    const subs = await store.submissions.listSubmissions(cohort.id);
    let objects = 0;
    for (const s of subs) {
      const detail = await store.submissions.getSubmissionDetail(s.submission.id);
      objects += (detail?.artifacts ?? []).filter((a) => a.storagePath).length;
    }
    console.log(`  Storage objects referenced: ${objects} (NOT removed by any database delete)`);
  }
}
main();
