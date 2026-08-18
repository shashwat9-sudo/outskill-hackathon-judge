/**
 * Queue and orchestration at hackathon scale.
 *
 * The judging pipeline has been proven end to end on one submission with a real
 * browser and a real model. What that cannot tell us is whether the *queue*
 * holds up at 400 jobs with workers competing for them — and that is the part
 * that fails on the night, not the scoring.
 *
 * So this exercises the real database, the real job creation, the real leasing
 * SQL, real concurrency, real retries and real completion, with only the
 * assessment *execution* replaced by an instant stub. Four hundred browser runs
 * would take a day and four hundred paid model calls would cost money to prove
 * something about Postgres.
 *
 * Real PostgreSQL, not PGlite: PGlite is one connection in one process, and a
 * lease race needs genuinely concurrent sessions. This boots a real server on a
 * temporary port, runs the real migrations, and throws it away afterwards.
 *
 *   node scripts/judging-scale-test.mjs [jobCount] [workerCount]
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const JOBS = Number(process.argv[2] ?? 400);
const WORKERS = Number(process.argv[3] ?? 8);
const LEASE_SECONDS = 30;

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
const rule = () => log('─'.repeat(72));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ohj-scale-'));
  const port = 5500 + Math.floor(Math.random() * 400);
  const server = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'),
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  log(`\nBooting PostgreSQL on ${port}…`);
  await server.initialise();
  await server.start();
  await server.createDatabase('judge');

  const pool = new pg.Pool({
    connectionString: `postgresql://postgres:postgres@localhost:${port}/judge`,
    max: WORKERS + 4,
  });

  try {
    // The real migrations, in order.
    const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrations) {
      const sql = readFileSync(join('supabase/migrations', file), 'utf8');
      try {
        await pool.query(sql);
      } catch (error) {
        // Storage and RLS policies reference Supabase-only roles and schemas.
        // The queue does not, and it is the queue under test.
        if (!/storage|auth|role .* does not exist|extension/i.test(String(error.message))) throw error;
        log(`  · skipped ${file} (needs Supabase-only objects)`);
      }
    }
    log(`  ✅ ${migrations.length} migration file(s) applied`);

    // ---- Fixture cohort and submissions -----------------------------------
    await pool.query(`insert into rubric_versions (version, name, is_active) values ('rubric-v1','Scale',true)`);
    const { rows: rv } = await pool.query(`select id from rubric_versions limit 1`);
    const { rows: cohortRows } = await pool.query(
      `insert into cohorts (name, code, description, timezone, day12_start_at, day13_deadline_at,
         shortlist_target, submission_instructions, rubric_version_id, assessment_config, status)
       values ('SCALE TEST','SCALE','','Asia/Kolkata', now() - interval '2 days', now() - interval '1 day',
         10,'',$1,'{}'::jsonb,'closed') returning id`,
      [rv[0].id],
    );
    const cohortId = cohortRows[0].id;

    log(`\nCreating ${JOBS} synthetic submissions…`);
    const submissionIds = [];
    for (let i = 0; i < JOBS; i += 1) {
      const { rows: team } = await pool.query(
        `insert into teams (cohort_id, group_number) values ($1,$2) returning id`,
        [cohortId, i + 1],
      );
      const { rows: sub } = await pool.query(
        `insert into submissions (cohort_id, team_id, status, product_name, submitted_at)
         values ($1,$2,'locked',$3, now()) returning id`,
        [cohortId, team[0].id, `Synthetic product ${i + 1}`],
      );
      submissionIds.push(sub[0].id);
    }
    log(`  ✅ ${submissionIds.length} locked submissions`);

    // ---- Job creation, twice, to prove idempotency -------------------------
    const created = async () => {
      let n = 0;
      for (const id of submissionIds) {
        const { rowCount } = await pool.query(
          `insert into assessment_jobs (submission_id, cohort_id, stage, attempt_count)
           values ($1,$2,'queued',0) on conflict (submission_id) do nothing`,
          [id, cohortId],
        );
        n += rowCount ?? 0;
      }
      return n;
    };

    const firstPass = await created();
    const secondPass = await created();
    log(`\nJob creation: ${firstPass} created, ${secondPass} created on a second identical pass`);

    const { rows: jobTotal } = await pool.query(`select count(*)::int as n from assessment_jobs`);
    log(`  ✅ ${jobTotal[0].n} jobs for ${submissionIds.length} submissions`);

    // ---- Workers ------------------------------------------------------------
    //
    // The real leasing statement: `for update skip locked` to pick a row, plus a
    // post-lock re-check of `claimed_by` so correctness does not rest on
    // SKIP LOCKED alone.
    const claim = async (workerId) => {
      const { rows } = await pool.query(
        `update assessment_jobs j
            set claimed_by = $1,
                claimed_at = now(),
                lease_expires_at = now() + ($2 || ' seconds')::interval,
                attempt_count = j.attempt_count + 1,
                updated_at = now()
          where j.id in (
            select c.id from assessment_jobs c
             where c.stage <> 'completed' and c.stage <> 'failed'
               and (c.claimed_by is null or c.lease_expires_at < now())
             order by c.priority desc, c.created_at
             limit 1
             for update skip locked)
            and (j.claimed_by is null or j.lease_expires_at < now())
        returning j.id, j.attempt_count as attempts`,
        [workerId, LEASE_SECONDS],
      );
      return rows[0] ?? null;
    };

    const stats = {
      leased: 0, completed: 0, failed: 0, retried: 0,
      doubleClaims: 0, errors: 0,
    };
    const seenBy = new Map();

    /** One worker, looping until the queue is empty. */
    const runWorker = async (workerId) => {
      for (;;) {
        let job;
        try {
          job = await claim(`worker-${workerId}`);
        } catch (error) {
          stats.errors += 1;
          log(`  ✗ claim failed: ${error.message}`);
          return;
        }
        if (!job) return;

        stats.leased += 1;

        // A job claimed twice at once is the failure this whole design exists to
        // prevent. Recorded rather than asserted so the count is reportable.
        const previous = seenBy.get(job.id);
        if (previous && previous.open) stats.doubleClaims += 1;
        seenBy.set(job.id, { open: true, worker: workerId });

        // Assessment execution, stubbed. Everything around it is real.
        //
        // One job in twenty fails on its first attempt, so retry and recovery
        // are exercised rather than assumed.
        const shouldFail = job.attempts === 1 && stats.leased % 20 === 0;

        if (shouldFail) {
          stats.retried += 1;
          await pool.query(
            `update assessment_jobs set claimed_by = null, lease_expires_at = null,
                    last_error = 'synthetic transient failure', updated_at = now()
              where id = $1`,
            [job.id],
          );
          seenBy.set(job.id, { open: false, worker: workerId });
          continue;
        }

        await pool.query(
          `update assessment_jobs
              set stage = 'completed', claimed_by = null, lease_expires_at = null,
                  completed_at = now(), updated_at = now()
            where id = $1`,
          [job.id],
        );
        stats.completed += 1;
        seenBy.set(job.id, { open: false, worker: workerId });
      }
    };

    log(`\nRunning ${WORKERS} concurrent workers…`);
    const started = Date.now();
    await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(i + 1)));
    const elapsed = Date.now() - started;

    // ---- What the database says afterwards ---------------------------------
    const { rows: byStage } = await pool.query(
      `select stage, count(*)::int as n from assessment_jobs group by stage order by stage`,
    );
    const { rows: stuck } = await pool.query(
      `select count(*)::int as n from assessment_jobs
        where stage <> 'completed' and stage <> 'failed'`,
    );
    const { rows: heldLeases } = await pool.query(
      `select count(*)::int as n from assessment_jobs where claimed_by is not null`,
    );
    const { rows: dupes } = await pool.query(
      `select count(*)::int as n from (
         select submission_id from assessment_jobs group by submission_id having count(*) > 1
       ) d`,
    );
    const { rows: attempts } = await pool.query(
      `select max(attempt_count)::int as most from assessment_jobs`,
    );

    rule();
    log('SCALE TEST RESULT');
    rule();
    log(`  jobs created            ${jobTotal[0].n}`);
    log(`  duplicate creation      ${secondPass} (second identical pass)`);
    log(`  submissions with >1 job ${dupes[0].n}`);
    log(`  jobs leased             ${stats.leased}`);
    log(`  jobs completed          ${stats.completed}`);
    log(`  retried after failure   ${stats.retried}`);
    log(`  max attempts on any job ${attempts[0].most}`);
    log(`  double-claimed at once  ${stats.doubleClaims}`);
    log(`  stuck (not completed)   ${stuck[0].n}`);
    log(`  leases still held       ${heldLeases[0].n}`);
    log(`  claim errors            ${stats.errors}`);
    log(`  wall clock              ${elapsed} ms`);
    log(`  throughput              ${Math.round((stats.completed / elapsed) * 1000)} jobs/second`);
    log(`  stage distribution      ${byStage.map((r) => `${r.stage}=${r.n}`).join(' ')}`);

    // ---- Stale-lease recovery ----------------------------------------------
    //
    // A worker that dies mid-job leaves a lease behind. Nothing may be lost by
    // that: the next worker along must be able to pick it up once the lease has
    // expired, and not one moment sooner.
    rule();
    log('STALE LEASE RECOVERY');
    rule();
    const { rows: victim } = await pool.query(`select id from assessment_jobs limit 1`);
    await pool.query(
      `update assessment_jobs
          set stage = 'browser_testing', claimed_by = 'worker-that-died',
              lease_expires_at = now() + interval '1 hour', completed_at = null
        where id = $1`,
      [victim[0].id],
    );
    const blocked = await claim('worker-new');
    log(`  live lease honoured     ${blocked === null ? 'yes — not stolen' : 'NO — claimed anyway'}`);

    await pool.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 second' where id = $1`,
      [victim[0].id],
    );
    const recovered = await claim('worker-new');
    log(`  expired lease recovered ${recovered ? `yes — by worker-new (attempt ${recovered.attempts})` : 'NO — job lost'}`);

    rule();
    const clean =
      dupes[0].n === 0 &&
      stats.doubleClaims === 0 &&
      stuck[0].n === 0 &&
      stats.errors === 0 &&
      secondPass === 0 &&
      blocked === null &&
      recovered !== null;
    log(clean ? 'PASS — no duplicates, no double claims, nothing stuck, leases behave' : 'FAIL — see the counts above');
    rule();
    process.exitCode = clean ? 0 : 1;
  } finally {
    await pool.end();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error?.stack ?? error}\n`);
  process.exit(1);
});
