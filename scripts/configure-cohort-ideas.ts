/**
 * Reconcile one cohort's idea catalogue with the declared one, safely.
 *
 * A new cohort inherits the previous cohort's ideas, which is how AIAP C14 came
 * to hold C13's catalogue and how every C14 sheet row was blocked with
 * "Category — Does not match one of the approved ideas". The eight C14 ideas
 * are declared in `packages/shared/src/config/cohort-ideas/aiap-c14.ts`; this
 * script applies them to the cohort mapped to `AIAP-C14` and to no other.
 *
 * Dry by default. Nothing is written without `--apply`.
 *
 *   npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id AIAP-C14
 *   npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id AIAP-C14 --apply
 *
 * Optional cohort-level corrections, each explicit and each also dry by default:
 *
 *   --final-selection-target 3     how many winners a person records (0014)
 *   --shortlist-target 10          the private top N
 *   --prompt-version current       stamp the version the prompts actually carry
 *   --expect-name "AIAP C14"       refuse unless the cohort's name contains this
 *   --backup-dir docs/AI_HANDOVER  where the before-change JSON is written
 *
 * What it will not do: create a cohort, rename one, touch a cohort other than
 * the one the external id maps to, delete an idea (obsolete ideas are
 * deactivated, so a past submission still resolves), import a submission, or
 * start judging. Every idea write goes through the same `CohortStore` methods
 * the admin screens use. Running it twice is safe: the second run finds
 * nothing to change.
 *
 * Reads `DATABASE_URL` from `.env.local`. Prints no secret.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresDatabase, type SqlDatabase } from '../packages/shared/src/data/postgres/client';
import { buildCohortStore } from '../packages/shared/src/data/postgres/repositories/admin';
import { buildRankingStore } from '../packages/shared/src/data/postgres/repositories/ranking';
import {
  applyIdeaCatalogue,
  planIdeaCatalogue,
  verifyIdeaCatalogue,
} from '../packages/shared/src/domain/idea-catalogue';
import { findCohortIdeaCatalogue } from '../packages/shared/src/config/cohort-ideas/index';
import { isValidFinalSelectionTarget } from '../packages/shared/src/domain/ranking';
import { PROMPT_VERSION } from '../packages/ai/src/prompts';

const ACTOR = 'configure-cohort-ideas';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  externalCohortId: string;
  /**
   * Identify the cohort by its exact uuid instead of by external id.
   *
   * For the one situation the external id cannot be used: the cohort exists
   * but has never been mapped. With `--bind-external-id` and `--apply` the
   * mapping is written, once, after the name check passes.
   */
  cohortId: string | null;
  bindExternalId: boolean;
  apply: boolean;
  expectName: string | null;
  finalSelectionTarget: number | null;
  shortlistTarget: number | null;
  promptVersion: 'current' | null;
  backupDir: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(message?: string): never {
  if (message) console.error(`\n  ✖ ${message}\n`);
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id <ID> [--apply]',
      '      [--cohort-id <uuid> [--bind-external-id]]',
      '      [--expect-name <text>] [--final-selection-target <n>] [--shortlist-target <n>]',
      '      [--prompt-version current] [--backup-dir <dir>]',
      '',
      'Dry run by default. --apply writes, and only to the one cohort identified.',
      '--cohort-id names a cohort by uuid when none is mapped to <ID> yet; with',
      '--bind-external-id and --apply, the mapping is written first.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    externalCohortId: '',
    cohortId: null,
    bindExternalId: false,
    apply: false,
    expectName: null,
    finalSelectionTarget: null,
    shortlistTarget: null,
    promptVersion: null,
    backupDir: 'docs/AI_HANDOVER',
  };
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--external-cohort-id':
        options.externalCohortId = takeValue(arg, i);
        i += 1;
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--cohort-id': {
        const value = takeValue(arg, i);
        if (!UUID.test(value)) usage('--cohort-id must be a full uuid.');
        options.cohortId = value.toLowerCase();
        i += 1;
        break;
      }
      case '--bind-external-id':
        options.bindExternalId = true;
        break;
      case '--expect-name':
        options.expectName = takeValue(arg, i);
        i += 1;
        break;
      case '--final-selection-target': {
        const n = Number(takeValue(arg, i));
        if (!isValidFinalSelectionTarget(n)) usage('--final-selection-target must be a whole number from 1 to 100.');
        options.finalSelectionTarget = n;
        i += 1;
        break;
      }
      case '--shortlist-target': {
        const n = Number(takeValue(arg, i));
        if (!Number.isInteger(n) || n < 1 || n > 100) usage('--shortlist-target must be a whole number from 1 to 100.');
        options.shortlistTarget = n;
        i += 1;
        break;
      }
      case '--prompt-version': {
        const value = takeValue(arg, i);
        if (value !== 'current') usage('--prompt-version accepts only "current".');
        options.promptVersion = 'current';
        i += 1;
        break;
      }
      case '--backup-dir':
        options.backupDir = takeValue(arg, i);
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        usage(`Unknown argument: ${arg}`);
    }
  }
  if (!options.externalCohortId) usage('--external-cohort-id is required. Nothing is guessed from a display name.');
  if (options.bindExternalId && !options.cohortId) usage('--bind-external-id needs --cohort-id.');
  return options;
}

// ---------------------------------------------------------------------------
// Environment — the connection string only, and never printed
// ---------------------------------------------------------------------------

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync('.env.local')) {
    throw new Error('DATABASE_URL is not set and .env.local does not exist. Run from the repository root.');
  }
  const match = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(readFileSync('.env.local', 'utf8'));
  if (!match?.[1]) throw new Error('DATABASE_URL is not set in .env.local');
  return match[1];
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

interface CohortRow {
  id: string;
  name: string;
  code: string;
  status: string;
  external_cohort_id: string;
  shortlist_target: number;
  final_selection_target: number | null;
  is_synthetic: boolean;
  rubric_version: string;
  assessment_config: Record<string, unknown> | string;
}

/** The columns this script relies on. A schema without them is refused, not guessed at. */
async function assertSchema(db: SqlDatabase, needsFinalTarget: boolean): Promise<void> {
  const required = [
    ['cohorts', 'external_cohort_id'],
    ['cohorts', 'is_synthetic'],
    ['cohort_ideas', 'definition_status'],
    ['cohort_ideas', 'is_active'],
    ['cohort_ideas', 'display_order'],
    ...(needsFinalTarget ? [['cohorts', 'final_selection_target']] : []),
  ];
  for (const [table, column] of required) {
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = $2`,
      [table, column],
    );
    if (rows.length === 0) {
      throw new Error(
        `Incompatible schema: ${table}.${column} does not exist. ` +
          (column === 'final_selection_target'
            ? 'Apply supabase/migrations/0014_final_selection_target.sql first.'
            : 'Refusing to continue.'),
      );
    }
  }
}

async function hasFinalSelectionTargetColumn(db: SqlDatabase): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cohorts' and column_name = 'final_selection_target'`,
  );
  return rows.length > 0;
}

/**
 * Exactly one cohort, by external id — or, when told, by uuid.
 *
 * Never by display name. A uuid is accepted only for the one case the external
 * id cannot serve: the cohort exists and has never been mapped. Even then the
 * name must contain the expected text, so a mistyped uuid that lands on
 * another cohort is refused rather than configured.
 */
async function identifyCohort(
  db: SqlDatabase,
  options: { externalCohortId: string; cohortId: string | null; expectName: string | null },
): Promise<CohortRow> {
  const targetColumn = (await hasFinalSelectionTargetColumn(db))
    ? 'c.final_selection_target'
    : 'null::integer as final_selection_target';
  const select = `select c.id, c.name, c.code, c.status::text as status, c.external_cohort_id,
            c.shortlist_target, c.is_synthetic, c.assessment_config,
            rv.version as rubric_version, ${targetColumn}
       from cohorts c
       join rubric_versions rv on rv.id = c.rubric_version_id`;

  const { rows } = options.cohortId
    ? await db.query<CohortRow>(`${select} where c.id = $1`, [options.cohortId])
    : await db.query<CohortRow>(`${select} where c.external_cohort_id = $1`, [options.externalCohortId]);

  if (rows.length !== 1) {
    throw new Error(
      options.cohortId
        ? `No cohort has id ${options.cohortId}.`
        : `Expected exactly one cohort mapped to external id "${options.externalCohortId}", found ${rows.length}. ` +
          'Refusing: a display name is never used to pick a cohort. If the cohort exists but was never mapped, ' +
          'name it by uuid with --cohort-id <uuid> --bind-external-id.',
    );
  }
  const cohort = rows[0]!;
  if (options.expectName && !cohort.name.toLowerCase().includes(options.expectName.toLowerCase())) {
    throw new Error(
      `The cohort ${options.cohortId ? `with id ${options.cohortId}` : `mapped to "${options.externalCohortId}"`} ` +
        `is named "${cohort.name}", which does not contain "${options.expectName}". Refusing. ` +
        'Pass --expect-name to override deliberately.',
    );
  }
  if (options.cohortId && cohort.external_cohort_id && cohort.external_cohort_id !== options.externalCohortId) {
    throw new Error(
      `Cohort "${cohort.name}" is already mapped to "${cohort.external_cohort_id}", not "${options.externalCohortId}". Refusing.`,
    );
  }
  return cohort;
}

/**
 * Write the external mapping for one cohort, once.
 *
 * The mapping decides which ranking a whole cohort's submissions land in, so
 * it is refused if any other cohort already carries the id, and it is never
 * moved off a cohort that has one. The unique index from migration 0010 is
 * the backstop for the same rule.
 */
async function bindExternalId(db: SqlDatabase, cohort: CohortRow, externalCohortId: string): Promise<void> {
  const { rows: others } = await db.query<{ id: string; name: string }>(
    'select id, name from cohorts where external_cohort_id = $1 and id <> $2',
    [externalCohortId, cohort.id],
  );
  if (others.length > 0) {
    throw new Error(
      `"${externalCohortId}" is already mapped to cohort "${others[0]!.name}" (${others[0]!.id}). Refusing to bind a second cohort.`,
    );
  }
  const { rowCount } = await db.query(
    `update cohorts set external_cohort_id = $2, updated_at = now()
      where id = $1 and (external_cohort_id is null or external_cohort_id = $2)`,
    [cohort.id, externalCohortId],
  );
  if (rowCount !== 1) throw new Error('The binding was not written; the cohort changed underneath this run.');
}

// ---------------------------------------------------------------------------
// Backup — configuration only, no secret and no learner data
// ---------------------------------------------------------------------------

function backupPrefix(externalCohortId: string): string {
  const tail = externalCohortId.split(/[^A-Za-z0-9]+/).filter(Boolean).pop() ?? externalCohortId;
  return tail.toUpperCase();
}

function writeBackup(dir: string, filename: string, payload: unknown): string {
  mkdirSync(dir, { recursive: true });
  let target = join(dir, filename);
  if (existsSync(target)) {
    // The first "before" is the one that matters; never overwrite it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    target = join(dir, filename.replace(/\.json$/, `_${stamp}.json`));
  }
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return target;
}

// ---------------------------------------------------------------------------

const say = (message: string) => console.log(`  · ${message}`);
const done = (message: string) => console.log(`  ✅ ${message}`);
const warn = (message: string) => console.log(`  ⚠️  ${message}`);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalogue = findCohortIdeaCatalogue(options.externalCohortId);
  if (!catalogue) {
    throw new Error(
      `No idea catalogue is declared for "${options.externalCohortId}". ` +
        'Add one under packages/shared/src/config/cohort-ideas/ before configuring this cohort.',
    );
  }
  const expectName = options.expectName ?? catalogue.expectedCohortNameIncludes;

  console.log('');
  console.log(options.apply ? 'Configure cohort ideas — APPLY' : 'Configure cohort ideas — DRY RUN (nothing is written)');
  console.log('');

  const db = await createPostgresDatabase({ connectionString: databaseUrl(), maxConnections: 2 });
  try {
    await assertSchema(db, options.finalSelectionTarget !== null);
    const cohort = await identifyCohort(db, {
      externalCohortId: options.externalCohortId,
      cohortId: options.cohortId,
      expectName,
    });
    const config =
      typeof cohort.assessment_config === 'string'
        ? (JSON.parse(cohort.assessment_config) as Record<string, unknown>)
        : cohort.assessment_config;

    done(`Target cohort: "${cohort.name}" (code ${cohort.code}, status ${cohort.status})`);
    say(`id ${cohort.id}`);
    say(`external id ${cohort.external_cohort_id ?? '(not mapped)'} · rubric ${cohort.rubric_version} · prompt ${String(config.promptVersion ?? 'unset')}`);

    if (!cohort.external_cohort_id) {
      if (options.bindExternalId) {
        say(`external id (none) → ${options.externalCohortId}${options.apply ? '' : ' (dry run: not written)'}`);
      } else {
        warn(
          `this cohort is not mapped to "${options.externalCohortId}". Sheet intake will not find it and would create a new cohort on Import. ` +
            'Re-run with --bind-external-id to map it.',
        );
      }
    }
    say(
      `shortlist target ${cohort.shortlist_target} · winners ${cohort.final_selection_target ?? '(column absent — 0014 not applied)'} · synthetic ${cohort.is_synthetic}`,
    );

    const cohorts = buildCohortStore(db);
    const ranking = buildRankingStore(db);
    const existing = await cohorts.listIdeas(cohort.id, { includeInactive: true });

    // --- Backup, before anything else ---------------------------------------
    const { rows: counts } = await db.query<Record<string, unknown>>(
      `select
         (select count(*) from submissions s where s.cohort_id = $1) as submissions,
         (select count(*) from submissions s where s.cohort_id = $1 and s.status in ('submitted','locked')) as final_submissions,
         (select count(*) from assessment_jobs j where j.cohort_id = $1) as jobs,
         (select count(*) from assessment_jobs j where j.cohort_id = $1 and j.stage = 'completed') as completed_jobs,
         (select count(*) from feedback_reports f join submissions s on s.id = f.submission_id where s.cohort_id = $1) as feedback_reports`,
      [cohort.id],
    );
    const finalSelections = await ranking.listFinalSelections(cohort.id);
    const backup = {
      takenAt: new Date().toISOString(),
      mode: options.apply ? 'before-apply' : 'dry-run',
      cohort: {
        id: cohort.id,
        name: cohort.name,
        code: cohort.code,
        status: cohort.status,
        externalCohortId: cohort.external_cohort_id,
        rubricVersion: cohort.rubric_version,
        promptVersion: config.promptVersion ?? null,
        modelVersion: config.modelVersion ?? null,
        shortlistTarget: cohort.shortlist_target,
        finalSelectionTarget: cohort.final_selection_target,
        isSynthetic: cohort.is_synthetic,
      },
      counts: counts[0] ?? {},
      ideas: existing.map((idea) => ({
        id: idea.id,
        title: idea.title,
        slug: idea.slug,
        displayOrder: idea.displayOrder,
        isActive: idea.isActive,
        definitionStatus: idea.definitionStatus,
        definitionApprovedAt: idea.definitionApprovedAt,
        definitionApprovedBy: idea.definitionApprovedBy,
        description: idea.description,
        targetUser: idea.targetUser,
        expectedUseCase: idea.expectedUseCase,
        minimumCoreFlow: idea.minimumCoreFlow,
        expectedEntities: idea.expectedEntities,
        aiOpportunity: idea.aiOpportunity,
        allowedScope: idea.allowedScope,
        unsafeInterpretations: idea.unsafeInterpretations,
      })),
      finalSelections: finalSelections.map((s) => ({
        position: s.position,
        submissionId: s.submissionId,
        groupNumber: s.groupNumber,
        selectedBy: s.selectedBy,
        selectedAt: s.selectedAt,
      })),
    };
    const prefix = backupPrefix(options.externalCohortId);
    const ideasBackup = writeBackup(options.backupDir, `${prefix}_IDEAS_BEFORE_CHANGE.json`, backup);
    done(`Backup written: ${ideasBackup}`);
    if (options.finalSelectionTarget !== null) {
      const selectionBackup = writeBackup(options.backupDir, `${prefix}_FINAL_SELECTION_BEFORE_CHANGE.json`, {
        takenAt: backup.takenAt,
        mode: backup.mode,
        cohort: backup.cohort,
        finalSelections: backup.finalSelections,
      });
      done(`Backup written: ${selectionBackup}`);
    }

    // --- Plan -----------------------------------------------------------------
    const plan = planIdeaCatalogue(cohort.id, existing, catalogue.ideas);
    console.log('');
    console.log('Idea catalogue plan:');
    if (plan.problems.length > 0) {
      for (const problem of plan.problems) console.log(`  ✖ ${problem}`);
      throw new Error('The plan has problems; nothing will be applied.');
    }
    for (const definition of plan.create) say(`create      ${definition.slug}  "${definition.title}"  (order ${definition.displayOrder})`);
    for (const { idea, definition, changes } of plan.update) {
      say(`update      ${idea.slug} → "${definition.title}"  changes: ${changes.join(', ')}`);
    }
    for (const idea of plan.approve) say(`approve     ${idea.slug}  "${idea.title}"`);
    for (const idea of plan.deactivate) say(`deactivate  ${idea.slug}  "${idea.title}"  (kept, not deleted)`);
    for (const idea of plan.unchanged) say(`unchanged   ${idea.slug}  "${idea.title}"`);
    const ideaWork = plan.create.length + plan.update.length + plan.approve.length + plan.deactivate.length;
    if (ideaWork === 0) done('The catalogue is already configured and approved.');

    // --- Cohort-level corrections -------------------------------------------
    const cohortPatch: { shortlistTarget?: number; finalSelectionTarget?: number; assessmentConfig?: Record<string, unknown> } = {};
    console.log('');
    console.log('Cohort settings:');
    if (options.shortlistTarget !== null) {
      if (cohort.shortlist_target === options.shortlistTarget) say(`shortlist target already ${options.shortlistTarget}`);
      else {
        say(`shortlist target ${cohort.shortlist_target} → ${options.shortlistTarget}`);
        cohortPatch.shortlistTarget = options.shortlistTarget;
      }
    }
    if (options.finalSelectionTarget !== null) {
      if (cohort.final_selection_target === options.finalSelectionTarget) {
        say(`winners to select already ${options.finalSelectionTarget}`);
      } else {
        say(`winners to select ${cohort.final_selection_target ?? 'unset'} → ${options.finalSelectionTarget}`);
        if (finalSelections.length > 0 && finalSelections.length !== options.finalSelectionTarget) {
          warn(
            `${finalSelections.length} winner(s) are already recorded for this cohort; the recorded set will no longer match the target. Clear or re-record it on the Finalists page.`,
          );
        }
        cohortPatch.finalSelectionTarget = options.finalSelectionTarget;
      }
    }
    if (options.promptVersion === 'current') {
      if (config.promptVersion === PROMPT_VERSION) say(`prompt version already ${PROMPT_VERSION}`);
      else {
        say(`prompt version ${String(config.promptVersion ?? 'unset')} → ${PROMPT_VERSION} (metadata only; the prompts themselves are unchanged)`);
        cohortPatch.assessmentConfig = { ...config, promptVersion: PROMPT_VERSION };
      }
    }
    if (options.shortlistTarget === null && options.finalSelectionTarget === null && options.promptVersion === null) {
      say('no cohort-level flags given; settings left as they are');
    }
    const settingsWork = Object.keys(cohortPatch).length;

    const bindWork = !cohort.external_cohort_id && options.bindExternalId ? 1 : 0;
    if (!options.apply) {
      console.log('');
      console.log(
        ideaWork + settingsWork + bindWork === 0
          ? 'Dry run complete. Nothing to change.'
          : `Dry run complete. ${bindWork ? 'the external-id binding, ' : ''}${ideaWork} idea change(s) and ${settingsWork} setting change(s) would be applied. Re-run with --apply.`,
      );
      return;
    }

    // --- Apply ----------------------------------------------------------------
    console.log('');
    console.log(`Applying to "${cohort.name}" (${cohort.id}) only…`);
    if (!cohort.external_cohort_id && options.bindExternalId) {
      await bindExternalId(db, cohort, options.externalCohortId);
      done(`external id bound: ${options.externalCohortId}`);
    }
    if (ideaWork > 0) {
      const result = await applyIdeaCatalogue(cohorts, cohort.id, catalogue.ideas, ACTOR);
      done(
        `ideas: ${result.created.length} created, ${result.updated.length} updated, ${result.approved.length} approved, ${result.deactivated.length} deactivated`,
      );
    }
    if (settingsWork > 0) {
      await cohorts.updateCohort(cohort.id, cohortPatch as Parameters<typeof cohorts.updateCohort>[1]);
      done(`cohort settings updated: ${Object.keys(cohortPatch).join(', ')}`);
    }

    // --- Verify ---------------------------------------------------------------
    const active = await cohorts.listIdeas(cohort.id);
    const verification = verifyIdeaCatalogue(active, catalogue.ideas);
    console.log('');
    console.log('Active catalogue now:');
    for (const idea of active) {
      say(`${String(idea.displayOrder).padStart(2)}  ${idea.title}  [${idea.slug}]  ${idea.definitionStatus}`);
    }
    if (!verification.ok) {
      for (const problem of verification.problems) console.log(`  ✖ ${problem}`);
      throw new Error('Verification failed after apply.');
    }
    done(`${active.length} active idea(s), all approved, titles and slugs unique.`);

    const after = await identifyCohort(db, {
      externalCohortId: options.externalCohortId,
      cohortId: cohort.id,
      expectName: null,
    });
    const afterConfig =
      typeof after.assessment_config === 'string'
        ? (JSON.parse(after.assessment_config) as Record<string, unknown>)
        : after.assessment_config;
    done(
      `settings now: shortlist ${after.shortlist_target} · winners ${after.final_selection_target ?? 'n/a'} · prompt ${String(afterConfig.promptVersion ?? 'unset')} · rubric ${after.rubric_version}`,
    );
  } finally {
    await db.close?.();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n  ✖ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
