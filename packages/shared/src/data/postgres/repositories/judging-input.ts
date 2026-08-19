import type { SqlDatabase } from '../client';
import type { JudgingInput } from '../../types';
import { SUBMISSION_COLUMNS, mapSubmission } from './submission-shared';
import { loadCohort } from './participant';
import { mapRow, mapRows, parseJson } from '../rows';

/**
 * Everything the judging pipeline needs, and nothing else.
 *
 * The worker used to call `getSubmissionDetail`, which is the admin submission
 * page in query form: the participant event timeline, the audit trail, manual
 * review flags, feedback reports, and — the reason this file exists — the
 * submission's rank and shortlist state, read from `ranking_entries`.
 *
 * With least privilege in force the worker has no grant on those tables, so the
 * whole read died with `permission denied for table ranking_entries` and every
 * healthy job failed on data it never wanted. Granting access would have made
 * the error go away and quietly undone ADR-018: the system ranks privately and
 * Outskill humans choose the Final Four, and a judging process that cannot see
 * the ranking cannot be steered by it. That guarantee should hold because the
 * query does not exist, not because a policy happens to return no rows.
 *
 * So this is the worker's own read. Every field below was taken from what the
 * pipeline actually dereferences — `submission.productUrl`, `cohort.rubricVersion`,
 * `cohort.assessmentConfig.browserBudgetMs`, the team and member names used to
 * detect a team judging itself, the idea being built against, the deck metadata
 * and the previous stage's artifact analysis. Nothing here reaches a table the
 * worker is not granted, so adding a field is a deliberate act rather than an
 * accident of reusing an admin view.
 *
 * Credentials are deliberately absent. They are fetched separately through
 * `revealCredentials`, at the moment of use, so that decrypting a team's
 * password is its own audited step rather than a side effect of loading a job.
 */
export interface JudgingInputStore {
  /**
   * The judging inputs for one submission, or null if there is no such
   * submission — or its cohort has no active rubric, which makes it unjudgeable.
   */
  getJudgingInput(submissionId: string): Promise<JudgingInput | null>;
}

export function buildJudgingInputStore(db: SqlDatabase): JudgingInputStore {
  return {
    async getJudgingInput(submissionId) {
      if (!/^[0-9a-fA-F-]{36}$/.test(submissionId)) return null;

      const { rows: submissionRows } = await db.query(
        `select ${SUBMISSION_COLUMNS} from submissions s where s.id = $1`,
        [submissionId],
      );
      if (submissionRows.length === 0) return null;
      const submission = mapSubmission(submissionRows[0] as Record<string, unknown>);

      /*
       * Four reads the worker is granted, and no more.
       *
       * `loadCohort` joins `rubric_versions`, so a cohort with no active rubric
       * returns null here and the caller treats the job as unjudgeable — which
       * is the honest outcome: there is nothing to score against.
       */
      const [teamRes, memberRes, ideaRes, artifactRes, analysisRes] = await Promise.all([
        db.query('select * from teams where id = $1', [submission.teamId]),
        db.query('select * from team_members where team_id = $1 order by created_at', [
          submission.teamId,
        ]),
        submission.ideaId
          ? db.query('select * from cohort_ideas where id = $1', [submission.ideaId])
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
        db.query(
          'select * from submission_artifacts where submission_id = $1 order by created_at',
          [submissionId],
        ),
        // Scoped through the job, because that is where an analysis is attached.
        db.query(
          `select a.* from artifact_analyses a
             join assessment_jobs j on j.id = a.job_id
            where j.submission_id = $1
            order by a.created_at desc
            limit 1`,
          [submissionId],
        ),
      ]);

      const cohort = await loadCohort(db, submission.cohortId);
      const teamRow = teamRes.rows[0] as Record<string, unknown> | undefined;
      if (!teamRow || !cohort) return null;

      const ideaRow = ideaRes.rows[0] as Record<string, unknown> | undefined;
      const analysisRow = analysisRes.rows[0] as Record<string, unknown> | undefined;

      return {
        submission,
        team: mapRow(teamRow),
        members: mapRows(memberRes.rows as Record<string, unknown>[]),
        cohort,
        // Same shape the participant repository produces, so the pipeline reads
        // an idea identically wherever it came from.
        idea: ideaRow
          ? (() => {
              const idea = mapRow<NonNullable<JudgingInput['idea']>>(ideaRow);
              return {
                ...idea,
                minimumCoreFlow: parseJson<string[]>(idea.minimumCoreFlow, []),
                expectedEntities: idea.expectedEntities ?? [],
              };
            })()
          : null,
        artifacts: mapRows(artifactRes.rows as Record<string, unknown>[]),
        artifactAnalysis: analysisRow ? mapRow(analysisRow) : null,
      };
    },
  };
}
