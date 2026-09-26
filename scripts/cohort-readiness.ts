/**
 * Is one cohort ready to be judged tomorrow? Read-only.
 *
 * Reads the database, the worker's self-report and — with `--sheet-dry-run` —
 * the Google Sheet, through exactly the code the admin screens use, and prints
 * a readiness report with a list of blockers. It imports nothing, queues
 * nothing, calls no model and writes nothing.
 *
 *   npx tsx scripts/cohort-readiness.ts --external-cohort-id AIAP-C14
 *   npx tsx scripts/cohort-readiness.ts --external-cohort-id AIAP-C14 --sheet-dry-run
 *
 * Exit code 1 when a blocker is found, so it can gate a runbook step.
 *
 * Reads `.env.local` for the connection string and, for the sheet check, the
 * Google service-account configuration. Prints no secret and no learner PII:
 * the sheet report carries group numbers, product names and reasons, which is
 * what the operator screen shows.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createPostgresDatabase } from '../packages/shared/src/data/postgres/client';
import { composePostgresDataStore } from '../packages/shared/src/data/postgres/store';
import { createInMemoryStorage } from '../packages/shared/src/data/postgres/storage';
import { findCohortIdeaCatalogue } from '../packages/shared/src/config/cohort-ideas/index';
import { verifyIdeaCatalogue } from '../packages/shared/src/domain/idea-catalogue';
import { RUBRIC_VERSION } from '../packages/shared/src/rubric/index';
import { readGoogleConfig, googleSheetsSource, checkGoogleConnectivity } from '../packages/shared/src/intake/google-sheets';
import { syncSheet } from '../packages/shared/src/intake/sheet-sync';
import { PROMPT_VERSION } from '../packages/ai/src/prompts';

const WORKER_STALE_AFTER_MS = 15 * 60_000;

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || match[2] === undefined) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    env[match[1] as string] = value;
  }
  return env;
}

interface Options {
  externalCohortId: string;
  sheetDryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { externalCohortId: '', sheetDryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--external-cohort-id') {
      options.externalCohortId = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--sheet-dry-run') {
      options.sheetDryRun = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!options.externalCohortId) {
    console.error('Usage: npx tsx scripts/cohort-readiness.ts --external-cohort-id <ID> [--sheet-dry-run]');
    process.exit(2);
  }
  return options;
}

const ok = (message: string) => console.log(`  ✅ ${message}`);
const info = (message: string) => console.log(`  · ${message}`);
const bad = (message: string) => console.log(`  ✖ ${message}`);
const warn = (message: string) => console.log(`  ⚠️  ${message}`);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const file = loadEnvFile('.env.local');
  const env = { ...file, ...process.env } as Record<string, string | undefined>;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set (environment or .env.local).');

  const db = await createPostgresDatabase({ connectionString, maxConnections: 2 });
  const store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: env.ADMIN_SESSION_SECRET ?? 's'.repeat(48),
    // Only ever used to seal a credential on import; a dry run seals nothing.
    credentialKey: env.CREDENTIAL_ENCRYPTION_KEY ?? 'a'.repeat(64),
    credentialKeyVersion: Number(env.CREDENTIAL_KEY_VERSION ?? 1),
  });

  try {
    console.log('');
    console.log(`Cohort readiness — ${options.externalCohortId} — ${new Date().toISOString()}`);

    // --- Cohort ---------------------------------------------------------------
    console.log('\nCohort');
    const cohorts = await store.cohorts.listCohorts();
    const matches = cohorts.filter((c) => c.externalCohortId === options.externalCohortId);
    if (matches.length !== 1) {
      bad(`expected exactly one cohort mapped to ${options.externalCohortId}, found ${matches.length}`);
      blockers.push('cohort mapping');
      info('cohorts in this database (newest first):');
      for (const c of cohorts) {
        info(`  ${c.id}  "${c.name}"  code ${c.code}  status ${c.status}  external ${c.externalCohortId ?? '(none)'}`);
      }
      info(
        'Bind the intended cohort with: npx tsx scripts/configure-cohort-ideas.ts ' +
          `--external-cohort-id ${options.externalCohortId} --cohort-id <uuid> --bind-external-id --apply`,
      );
    }
    const cohort = matches.length === 1 ? matches[0]! : null;
    if (cohort) {
    ok(`"${cohort.name}" (code ${cohort.code}) · id ${cohort.id}`);
    info(`status ${cohort.status} · deadline ${cohort.day13DeadlineAt.toISOString()} · timezone ${cohort.timezone}`);
    info(`rubric ${cohort.rubricVersion} · prompt ${cohort.assessmentConfig.promptVersion} · model label ${cohort.assessmentConfig.modelVersion}`);
    info(`shortlist target ${cohort.shortlistTarget} · winners to select ${cohort.finalSelectionTarget} · synthetic ${cohort.isSynthetic}`);
    info(`judging config: concurrency ${cohort.assessmentConfig.workerConcurrency} · browser budget ${Math.round(cohort.assessmentConfig.browserBudgetMs / 60_000)} min · max attempts ${cohort.assessmentConfig.maxAttempts}`);

    if (cohort.rubricVersion !== RUBRIC_VERSION) {
      bad(`rubric is ${cohort.rubricVersion}, code expects ${RUBRIC_VERSION}`);
      blockers.push('rubric version');
    }
    if (cohort.assessmentConfig.promptVersion !== PROMPT_VERSION) {
      warn(`prompt version metadata is ${cohort.assessmentConfig.promptVersion}; the prompts are ${PROMPT_VERSION} (fix: configure-cohort-ideas.ts --prompt-version current)`);
      warnings.push('prompt version metadata');
    }
    if (!Number.isFinite(cohort.assessmentConfig.browserBudgetMs) || cohort.assessmentConfig.browserBudgetMs <= 0) {
      bad('browser budget is not a positive number; every run would be abandoned instantly');
      blockers.push('browser budget');
    }

    const catalogue = findCohortIdeaCatalogue(options.externalCohortId);
    if (catalogue) {
      if (cohort.shortlistTarget !== catalogue.settings.shortlistTarget) {
        warn(`shortlist target is ${cohort.shortlistTarget}; the catalogue expects ${catalogue.settings.shortlistTarget}`);
        warnings.push('shortlist target');
      }
      if (cohort.finalSelectionTarget !== catalogue.settings.finalSelectionTarget) {
        bad(`winners to select is ${cohort.finalSelectionTarget}; the catalogue expects ${catalogue.settings.finalSelectionTarget}`);
        blockers.push('winner count');
      }
    }

    // --- Ideas ----------------------------------------------------------------
    console.log('\nIdeas');
    const all = await store.cohorts.listIdeas(cohort.id, { includeInactive: true });
    const active = all.filter((i) => i.isActive);
    for (const idea of all.sort((a, b) => a.displayOrder - b.displayOrder)) {
      info(`${idea.isActive ? 'active  ' : 'inactive'}  ${String(idea.displayOrder).padStart(2)}  ${idea.title}  [${idea.slug}]  ${idea.definitionStatus}`);
    }
    if (catalogue) {
      const verification = verifyIdeaCatalogue(active, catalogue.ideas);
      if (verification.ok) ok(`${active.length} active ideas match the declared catalogue and are approved`);
      else {
        for (const problem of verification.problems) bad(problem);
        blockers.push('idea catalogue');
      }
    } else {
      warn('no declared catalogue for this cohort; cannot verify ideas');
      if (active.some((i) => i.definitionStatus !== 'approved')) {
        bad('some active ideas have unapproved definitions');
        blockers.push('idea approval');
      }
    }

    // --- Submissions, queue, feedback -----------------------------------------
    console.log('\nSubmissions and judging');
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const byStatus = new Map<string, number>();
    for (const s of submissions) byStatus.set(s.submission.status, (byStatus.get(s.submission.status) ?? 0) + 1);
    info(`submissions: ${submissions.length}${submissions.length ? ` (${[...byStatus].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
    const stats = await store.assessment.getQueueStats(cohort.id);
    info(`jobs: ${stats.total} (completed ${stats.completed}, running ${stats.running}, failed ${stats.failed}, manual review ${stats.manualReview})`);
    const coverage = await store.assessment.getFeedbackCoverage(cohort.id);
    info(`feedback: completed ${coverage.completed} · ready ${coverage.ready} · pending ${coverage.pending} · generating ${coverage.generating} · failed ${coverage.failed}`);
    const snapshot = await store.ranking.getCurrentSnapshot(cohort.id);
    info(snapshot ? `ranking snapshot: ${snapshot.entries.length} entries (generated ${snapshot.generatedAt.toISOString()})` : 'ranking snapshot: none');
    const finals = await store.ranking.listFinalSelections(cohort.id);
    info(`recorded winners: ${finals.length} of ${cohort.finalSelectionTarget}`);

    }

    // --- Settings and worker --------------------------------------------------
    console.log('\nJudging infrastructure');
    const judgingEnabled = await store.settings.get<boolean>('judging.enabled');
    if (judgingEnabled === true) ok('judging.enabled = true');
    else {
      warn(`judging.enabled = ${String(judgingEnabled)} — "Start judging" will refuse until it is true (Settings page)`);
      warnings.push('judging.enabled');
    }

    const workers = await store.workers.list();
    if (workers.length === 0) {
      bad('no worker has ever reported in (worker_status is empty)');
      blockers.push('worker');
    }
    for (const worker of workers) {
      const silentMs = Date.now() - worker.lastSeenAt.getTime();
      const stale = silentMs > WORKER_STALE_AFTER_MS;
      const line = `${worker.workerId}: provider ${worker.aiProvider} · model ${worker.aiModel ?? '(default)'} · mode ${worker.evaluationMode} · demo ${worker.demoMode} · concurrency ${worker.concurrency} · last seen ${Math.round(silentMs / 60_000)} min ago`;
      if (stale) {
        warn(`${line} — STALE`);
      } else ok(line);
      if (worker.aiProvider === 'demo' || worker.demoMode) {
        bad(`worker ${worker.workerId} is in demo mode / demo provider`);
        blockers.push('worker provider');
      }
      if (worker.evaluationMode !== 'production' && !(cohort?.isSynthetic ?? false)) {
        bad(
          `worker ${worker.workerId} runs AI_EVALUATION_MODE=${worker.evaluationMode} and "${cohort?.name ?? options.externalCohortId}" is a real cohort — every AI call would be refused. Set AI_EVALUATION_MODE=production on the worker (after confirming the provider's data terms).`,
        );
        blockers.push('evaluation mode');
      }
    }
    if (workers.length > 0 && workers.every((w) => Date.now() - w.lastSeenAt.getTime() > WORKER_STALE_AFTER_MS)) {
      bad('every worker is stale; nothing will claim the queue');
      blockers.push('worker stale');
    }
    info(
      `web-tier env (informational; the worker's own report above is what counts): AI_PROVIDER=${env.AI_PROVIDER ?? 'unset'} · AI_MODEL ${env.AI_MODEL ? 'set' : 'unset'} · AI_EVALUATION_MODE=${env.AI_EVALUATION_MODE ?? 'unset'}`,
    );

    // --- Sheet (optional, read-only) ------------------------------------------
    if (options.sheetDryRun) {
      console.log('\nGoogle Sheet dry run (read-only)');
      const config = readGoogleConfig(env);
      if (!config) {
        bad('Google Sheets is not configured in the environment');
        blockers.push('sheet config');
      } else {
        const externalFromEnv = env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID;
        if (externalFromEnv !== options.externalCohortId) {
          bad(`GOOGLE_SHEETS_EXTERNAL_COHORT_ID is ${externalFromEnv ?? 'unset'}, not ${options.externalCohortId}`);
          blockers.push('sheet cohort id');
        }
        const connectivity = await checkGoogleConnectivity(config);
        if (!connectivity.ok) {
          bad(`connection failed: ${connectivity.error ?? 'unknown'}`);
          blockers.push('sheet connection');
        } else {
          ok(`connected as ${connectivity.serviceAccountEmail} · tab "${connectivity.tabName}" · ${connectivity.rowCount} data rows · headers: ${connectivity.headers.length}`);
          const report = await syncSheet({
            store,
            source: googleSheetsSource(config),
            externalCohortId: options.externalCohortId,
            cohortName: env.GOOGLE_SHEETS_COHORT_NAME ?? options.externalCohortId,
            dryRun: true,
          });
          if (report.fatalError) {
            bad(`dry run failed: ${report.fatalError}`);
            blockers.push('sheet dry run');
          } else {
            const ready = report.groups.filter((g) => g.status === 'ready').length;
            const blocked = report.groups.filter((g) => g.status === 'blocked');
            const categoryBlocks = report.errors.filter((e) => e.field === 'Category');
            const otherBlocks = report.errors.filter((e) => e.field !== 'Category');
            info(`rows found ${report.rowsRead} · blank skipped ${report.blankRowsIgnored} · valid ${report.validRows} · invalid ${report.invalidRows}`);
            info(`ready to import ${ready} · blocked ${blocked.length} · already imported ${report.alreadyIngested + report.groups.filter((g) => g.status === 'already_synced').length} · changed since import ${report.changedSinceSync.length}`);
            info(`resubmitted groups ${report.resubmittedGroups.length} · superseded rows ${report.groups.filter((g) => g.status === 'superseded').length}`);
            info(`category blocks ${categoryBlocks.length} · other validation blocks ${otherBlocks.length} · jobs a sync would create ${ready}`);
            for (const issue of report.errors) {
              info(`  row ${issue.row}${issue.groupNumber ? ` (group ${issue.groupNumber})` : ''}: ${issue.field} — ${issue.reason}`);
            }
            if (categoryBlocks.length > 0) {
              bad(`${categoryBlocks.length} row(s) blocked on Category`);
              blockers.push('category blocks');
            } else ok('category blocks = 0');
          }
        }
      }
    }

    // --- Verdict ----------------------------------------------------------------
    console.log('\nVerdict');
    for (const w of warnings) warn(`warning: ${w}`);
    if (blockers.length === 0) ok('no blockers');
    else for (const b of blockers) bad(`BLOCKER: ${b}`);
    if (blockers.length > 0) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ✖ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
