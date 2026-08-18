import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The wall between a team and the judging of it.
 *
 * A team may read and write everything about their own submission — save a
 * draft, upload a deck, finalise, download their receipt. What they must never
 * reach is what the system concluded *about* it: scores, evidence, confidence,
 * reviewer notes, manual-review flags, disqualification decisions, the ranking,
 * the Top 10, the finalists.
 *
 * The risk this guards is not a hostile participant guessing an endpoint. It is
 * an ordinary, well-meant change — someone adds "your score so far" to the
 * portal, or joins one more table to show a nicer status — and a working order
 * Outskill never published becomes a verdict a team read at midnight.
 *
 * So the boundary is checked structurally rather than by permissions:
 *
 *   1. Participant repositories must not name an assessment or ranking table.
 *   2. Participant routes and actions must not import an assessment repository.
 *   3. `ParticipantStore` must expose no method that returns judging data.
 *
 * Deliberately NOT a substring scan of method names. `finaliseSubmission` is a
 * team finalising their own work and contains "final"; matching on words would
 * flag it and teach the next person to weaken the test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

/**
 * Tables holding what the system concluded.
 *
 * `submissions`, `submission_artifacts`, `teams` and friends are absent on
 * purpose: those are the team's own work, which participant code obviously
 * reads and writes.
 */
const JUDGING_TABLES = [
  'assessment_jobs',
  'assessment_evidence',
  'assessment_summaries',
  'category_scores',
  'preflight_checks',
  'artifact_analyses',
  'test_plans',
  'test_plan_steps',
  'browser_test_runs',
  'browser_test_steps',
  'consistency_reviews',
  'manual_review_flags',
  'disqualifications',
  'ranking_snapshots',
  'ranking_entries',
  'final_selections',
  'feedback_reports',
] as const;

/** Repositories a participant request is allowed to reach. */
const PARTICIPANT_REPOSITORIES = ['postgres/repositories/participant.ts'];

/** Everything that serves a participant request. */
const PARTICIPANT_SURFACE = [
  'apps/web/src/app/submit',
  'apps/web/src/server/participant-actions.ts',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? [full] : [];
    }),
  );
  return nested.flat();
}

/** Strip comments so a table named in prose is not mistaken for a query. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --------------------------------------------------------------------------

describe('the participant repository', () => {
  it('never names a table holding judging data', async () => {
    const source = code(await readFile(resolve(HERE, PARTICIPANT_REPOSITORIES[0]!), 'utf8'));

    const found = JUDGING_TABLES.filter((table) =>
      new RegExp(`\\b${table}\\b`).test(source),
    );

    expect(
      found,
      'The participant repository queries a judging table. A team must not be ' +
        'able to read what the system concluded about their submission.',
    ).toEqual([]);
  });

  it('does read the tables it is supposed to', async () => {
    // Guards the guard: if the file stopped mentioning any table, the check
    // above would pass while proving nothing.
    const source = await readFile(resolve(HERE, PARTICIPANT_REPOSITORIES[0]!), 'utf8');
    expect(source).toMatch(/\bsubmissions\b/);
    expect(source).toMatch(/\bteams\b/);
  });
});

describe('participant routes and actions', () => {
  it('exist, so this is testing something', async () => {
    const files = (await Promise.all(PARTICIPANT_SURFACE.map((p) => sourceFiles(resolve(REPO, p)))))
      .flat()
      .concat(
        PARTICIPANT_SURFACE.filter((p) => p.endsWith('.ts')).map((p) => resolve(REPO, p)),
      );
    expect(files.length).toBeGreaterThan(3);
  });

  it('never import an assessment or ranking repository', async () => {
    const files = await participantFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = code(await readFile(file, 'utf8'));
      if (/from ['"].*repositories\/(assessment|ranking)/.test(source)) {
        offenders.push(file.replace(`${REPO}/`, ''));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never reach store.assessment or store.ranking', async () => {
    // The store is one object. Nothing stops a participant action calling
    // `store.assessment.listScores(...)` except this.
    const files = await participantFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = code(await readFile(file, 'utf8'));
      if (/\bstore\s*\.\s*(assessment|ranking)\b/.test(source)) {
        offenders.push(file.replace(`${REPO}/`, ''));
      }
    }

    expect(
      offenders,
      'A participant route reaches the assessment or ranking store.',
    ).toEqual([]);
  });

  it('never name a judging table in raw SQL', async () => {
    const files = await participantFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = code(await readFile(file, 'utf8'));
      for (const table of JUDGING_TABLES) {
        if (new RegExp(`\\b${table}\\b`).test(source)) {
          offenders.push(`${file.replace(`${REPO}/`, '')} → ${table}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the ParticipantStore contract', () => {
  it('declares no method returning judging data', async () => {
    // Read from the interface rather than an instance: a method that exists on
    // the type is one a caller can reach, whether or not it is implemented yet.
    const source = await readFile(resolve(HERE, 'store.ts'), 'utf8');
    const start = source.indexOf('export interface ParticipantStore');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n}', start));

    // Types the participant store must never mention in its signatures.
    const forbiddenTypes = [
      'CategoryScore',
      'AssessmentSummary',
      'AssessmentEvidence',
      'AssessmentJob',
      'RankingSnapshot',
      'RankingEntry',
      'RankedListItem',
      'FinalSelection',
      'Disqualification',
      'ManualReviewFlag',
      'BrowserTestRun',
      'PreflightCheck',
      'ConsistencyReview',
    ];

    const found = forbiddenTypes.filter((type) => new RegExp(`\\b${type}\\b`).test(block));
    expect(
      found,
      'ParticipantStore exposes a judging type in its contract.',
    ).toEqual([]);
  });

  it('still allows a team everything about their own submission', async () => {
    // The boundary must not be enforced by making the store useless.
    const source = await readFile(resolve(HERE, 'store.ts'), 'utf8');
    const start = source.indexOf('export interface ParticipantStore');
    const block = source.slice(start, source.indexOf('\n}', start));

    for (const allowed of ['saveDraft', 'finaliseSubmission', 'verifyTeamAccess', 'recordActivity']) {
      expect(block, `${allowed} should remain available to a team`).toMatch(
        new RegExp(`\\b${allowed}\\b`),
      );
    }
  });
});

describe('the feedback report', () => {
  it('is not exposed to participants in this version', async () => {
    // The column defaults false and the repository forces it false on write.
    // If that ever changes it should be a decision, not a diff nobody noticed.
    const migration = await readFile(
      resolve(REPO, 'supabase/migrations/0001_schema.sql'),
      'utf8',
    );
    expect(migration).toMatch(/is_exposed_to_participant boolean not null default false/);

    const repository = await readFile(
      resolve(HERE, 'postgres/repositories/assessment-judgment.ts'),
      'utf8',
    );
    expect(repository).toMatch(/is_exposed_to_participant[\s\S]{0,400}?false/);
  });
});

async function participantFiles(): Promise<string[]> {
  const fromDirs = await Promise.all(
    PARTICIPANT_SURFACE.filter((p) => !p.endsWith('.ts')).map((p) => sourceFiles(resolve(REPO, p))),
  );
  const singles = PARTICIPANT_SURFACE.filter((p) => p.endsWith('.ts')).map((p) => resolve(REPO, p));
  return [...fromDirs.flat(), ...singles];
}
