/**
 * A disposable synthetic cohort, for looking at the product rather than running it.
 *
 * Two presets: `ux-review` (one team, read the screens locally) and `staging`
 * (two teams, exercise a deployed build). Neither fills in a submission — the
 * point is to walk the journey cold, the way a participant will.
 *
 * What it deliberately does not do:
 *   - touch the archived acceptance cohort or group 901 (it refuses if it finds
 *     itself anywhere near them);
 *   - enqueue judging, or reach an AI provider;
 *   - print the access code, or the connection string, to the terminal.
 *
 * The code is written once to a CSV on the operator's machine, because a code
 * shown in a terminal ends up in scrollback, in a screenshot, and in a
 * transcript. It is generated exactly once and only its Argon2id hash is kept,
 * so this file is the only copy that will ever exist.
 *
 *   npx tsx scripts/seed-synthetic-cohort.ts ux-review
 *   npx tsx scripts/seed-synthetic-cohort.ts staging
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPostgresDatabase, type SqlDatabase } from '../packages/shared/src/data/postgres/client';
import { seedIdeaCatalogue } from '../packages/shared/src/data/postgres/bootstrap';
import { buildCohortStore } from '../packages/shared/src/data/postgres/repositories/admin';
import { buildTeamStore } from '../packages/shared/src/data/postgres/repositories/teams';

/**
 * Two presets, both disposable.
 *
 * `ux-review` is the single team used for reading the learner screens locally.
 * `staging` is two teams for exercising a deployed build end to end.
 */
const PRESETS = {
  'ux-review': {
    name: 'LEARNER UX REVIEW — DELETE LATER',
    code: 'UXREVIEW',
    groups: [801],
    csv: 'learner-ux-review-access-code.csv',
    status: 'open' as const,
  },
  staging: {
    name: 'STAGING SMOKE TEST — DELETE LATER',
    code: 'STAGING',
    groups: [811, 812],
    csv: 'staging-access-codes.csv',
    // Created closed, and opened through the deployed admin interface — which
    // is the transition the staging run is meant to exercise, and the one that
    // enforces "only one cohort faces learners at a time".
    status: 'draft' as const,
  },
  'upload-check': {
    name: 'UPLOAD CHECK — DELETE LATER',
    code: 'UPLOADCHK',
    groups: [821],
    csv: 'upload-check-access-code.csv',
    status: 'open' as const,
  },
} as const;

/**
 * Cohorts this script will never write to, under any preset.
 *
 * The first holds acceptance evidence. The second holds 640 real learners with
 * real addresses, and nothing synthetic may be issued against it — an access
 * code generated there is a code that could be sent to a person.
 */
const PROTECTED = /PRODUCTION TEST|AIAP C13 Demo/i;

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

const say = (message: string) => console.log(`  · ${message}`);
const done = (message: string) => console.log(`  ✅ ${message}`);

/**
 * The synthetic team.
 *
 * Names say what they are, and every address is `@example.com`, which RFC 2606
 * reserves precisely so that test data can never reach a real inbox.
 */
function learnersFor(groupNumber: number) {
  return ['Ada', 'Ben', 'Cara'].map((first) => ({
    name: `${first} Synthetic ${groupNumber}`,
    email: `${first.toLowerCase()}.${groupNumber}@example.com`,
  }));
}

async function guardProtectedCohorts(db: SqlDatabase, cohortName: string, wantOpen: boolean): Promise<void> {
  const { rows } = await db.query<{ name: string; status: string; real: string }>(`
    select c.name, c.status,
      (select count(*) from team_members m join teams t on t.id = m.team_id
        where t.cohort_id = c.id and m.email not like '%@example.com') as real
    from cohorts c`);

  for (const cohort of rows) {
    if (!PROTECTED.test(cohort.name)) continue;
    say(`"${cohort.name}" (${cohort.status}, ${cohort.real} real addresses) — not touched`);
  }

  if (!wantOpen) return;

  // Only one cohort may face learners, or the entry page cannot say which one a
  // team is signing in to. Refused rather than resolved: closing somebody
  // else's cohort is a much larger act than this script was asked to perform.
  const live = rows.filter((c) => c.status === 'open' || c.status === 'paused');
  const strangers = live.filter((c) => c.name !== cohortName);
  if (strangers.length > 0) {
    throw new Error(
      `Another cohort already faces learners: ${strangers.map((c) => `${c.name} (${c.status})`).join(', ')}. ` +
        'Close it first — this script will not change a cohort it did not create.',
    );
  }
}

async function main() {
  const presetName = (process.argv[2] ?? 'ux-review') as keyof typeof PRESETS;
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
  }
  const CSV_PATH = join(homedir(), 'Desktop', preset.csv);

  console.log(`\n=== ${preset.name} ===\n`);

  const env = loadEnvFile('.env.local');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set in .env.local');

  const db = await createPostgresDatabase({ connectionString: env.DATABASE_URL, maxConnections: 2 });

  try {
    await guardProtectedCohorts(db, preset.name, preset.status === 'open');

    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);

    // ---- The cohort ----
    const existing = await db.query<{ id: string; status: string }>(
      'select id, status from cohorts where name = $1',
      [preset.name],
    );

    let cohortId: string;
    if (existing.rows.length > 0) {
      cohortId = existing.rows[0]!.id;
      say('cohort already exists — reusing it rather than making a second');
    } else {
      const { rows: rubric } = await db.query<{ version: string }>(
        'select version from rubric_versions where is_active order by created_at desc limit 1',
      );
      if (rubric.length === 0) throw new Error('no active rubric version — run bootstrap first');

      const now = Date.now();
      const cohort = await cohorts.createCohort({
        name: preset.name,
        code: preset.code,
        description: 'Disposable synthetic cohort. Not a real cohort, and never judged.',
        timezone: 'Asia/Kolkata',
        // Open now, and a deadline far enough out that a countdown never
        // becomes the thing being reviewed.
        day12StartAt: new Date(now - 60 * 60 * 1000),
        day13DeadlineAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        shortlistTarget: 10,
        submissionInstructions:
          'This is a synthetic cohort for reviewing the submission experience. Nothing entered here is judged, and nothing is kept.',
        rubricVersion: rubric[0]!.version,
        /*
         * Present because the column requires it, and inert because nothing
         * will read it: no job is enqueued for this cohort, so no worker ever
         * consults these numbers. Written out rather than copied from the
         * archived cohort, which this script does not read from.
         */
        assessmentConfig: {
          workerConcurrency: 1,
          browserBudgetMs: 120_000,
          maxAttempts: 1,
          retryBackoffMs: 30_000,
          gracePeriodMs: 0,
          consistencyTopN: 0,
          lowConfidenceThreshold: 0.5,
          modelVersion: 'none — this cohort is never judged',
          promptVersion: 'none — this cohort is never judged',
        },
        status: preset.status,
        closedAt: null,
        closureType: null,
        acceptingUntil: null,
      });
      cohortId = cohort.id;
      done(`cohort created — ${preset.name}, status ${preset.status}`);

      const ideas = await seedIdeaCatalogue(db, cohortId);
      done(`${ideas} approved ideas copied in, so step 2 has something to choose`);
    }

    // ---- The team ----
    const result = await teams.importLearnerAllocation(
      cohortId,
      preset.groups.map((groupNumber) => ({
        groupNumber,
        whatsappLink: null,
        learners: learnersFor(groupNumber),
      })),
    );
    done(
      `groups ${preset.groups.join(', ')}: ${result.teamsCreated} team(s) created, ` +
        `${result.learnersAdded} members added` +
        (result.teamsMatched ? ` (${result.teamsMatched} already existed)` : ''),
    );

    // ---- The access code ----
    const issued = await teams.generateAccessCodes({ cohortId, regenerate: false });
    if (issued.length === 0) {
      say('a live code already exists for this team, and a code cannot be read back');
      say('delete the CSV and re-run with regenerate if you need a fresh one');
    } else {
      /**
       * Written, never printed.
       *
       * Not produced through the distribution-sheet builder on purpose: that
       * path refuses a localhost address, and rightly so — a sheet sent to
       * teams with `localhost` on it sends every one of them nowhere. This is
       * the case its own error message allows for, "running locally for testing
       * is fine", so the file says plainly what it is.
       */
      const baseUrl = process.env.APP_BASE_URL ?? env.APP_BASE_URL ?? 'http://localhost:3000';
      const cell = (value: unknown) => {
        const text = String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const csv = [
        '# SYNTHETIC TEST DATA — not a distribution sheet. These are not real people.',
        `# Cohort: ${preset.name}`,
        '',
        'group_number,team_lead,team_lead_email,access_code,submit_url',
        ...issued.map((row) =>
          [
            row.groupNumber,
            row.leadName ?? '(unnamed)',
            row.leadEmail ?? '(none)',
            row.code,
            `${baseUrl.replace(/\/$/, '')}/submit`,
          ]
            .map(cell)
            .join(','),
        ),
        '',
      ].join('\n');

      writeFileSync(CSV_PATH, csv, { mode: 0o600 });
      done(`${issued.length} access code(s) issued and written to ${CSV_PATH}`);
    }

    // ---- Prove nothing else was created ----
    const [{ rows: subs }, { rows: jobs }] = await Promise.all([
      db.query<{ n: string }>('select count(*) as n from submissions where cohort_id = $1', [cohortId]),
      db.query<{ n: string }>(
        `select count(*) as n from assessment_jobs j
           join submissions s on s.id = j.submission_id where s.cohort_id = $1`,
        [cohortId],
      ),
    ]);
    done(`${subs[0]!.n} submissions and ${jobs[0]!.n} judging jobs — nothing filled in, nothing queued`);

    console.log(`\n  Group numbers: ${preset.groups.join(', ')}`);
    console.log(`  Access codes:  in ${CSV_PATH} (never printed)`);
    console.log(`  Cohort status: ${preset.status}\n`);
  } finally {
    await db.close();
  }
}

if (!existsSync('.env.local')) {
  console.error('Run this from the repository root — .env.local was not found.');
  process.exit(1);
}

void main().catch((error) => {
  console.error(`\n  ❌ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
