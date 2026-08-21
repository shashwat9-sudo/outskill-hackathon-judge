/**
 * The admin submission surface.
 *
 * Reads join assessment tables that are empty until Phase B. That is deliberate
 * rather than gated: a `left join` against an empty table yields null, so the
 * admin list and detail pages render correctly with "not assessed yet" instead
 * of failing. Only the *actions* that would start judging are gated, and those
 * live in the store composition, not here.
 */

import type {
  AdminSubmissionDetail,
  AuditLog,
  CohortIdea,
  SubmissionArtifact,
  SubmissionCredentials,
  SubmissionDeclarations,
  SubmissionEvent,
  Team,
  TeamActivity,
  TeamMember,
} from '../../types';
import type { SubmissionListItem, SubmissionStore } from '../../store';
import { RowNotFoundError, type SqlDatabase } from '../client';
import { ARTIFACT_NUMERIC_COLUMNS, json, mapMaybe, mapRow, mapRows, mapRowsWithNumbers, parseJson, toNumber } from '../rows';
import { deserialiseEnvelope, decryptSecret, parseEncryptionKey } from '../../../security/crypto';
import {
  mapConsistencyReview,
  mapEvidence,
  mapFeedback,
  mapScore,
  mapSummary,
} from './assessment-judgment';
import { loadCohort } from './participant';
import { SUBMISSION_COLUMNS, SUBMISSION_RETURNING, mapSubmission } from './submission-shared';

export interface SubmissionDeps {
  db: SqlDatabase;
  credentialKey: string;
}

export function buildSubmissionStore(deps: SubmissionDeps): SubmissionStore {
  const { db } = deps;

  return {
    async listSubmissions(cohortId, filter) {
      // One statement rather than N+1. Every assessment join is a left join, so
      // a cohort with no judging yet still lists every submission.
      const { rows } = await db.query(
        `select ${SUBMISSION_COLUMNS},
                t.id as t_id, t.cohort_id as t_cohort_id, t.group_number, t.lead_name,
                t.lead_email, t.lead_phone, t.status as t_status, t.imported_at,
                t.created_at as t_created_at, t.updated_at as t_updated_at,
                i.title as idea_title,
                j.stage as stage,
                sum.total_score, sum.mean_confidence, sum.low_confidence,
                re.rank, re.in_shortlist,
                exists (
                  select 1 from manual_review_flags m
                   where m.submission_id = s.id and m.status = 'open'
                ) as has_open_manual_review,
                (
                  select d.status from disqualifications d
                   where d.submission_id = s.id
                   order by d.created_at desc limit 1
                ) as disqualification_status
           from submissions s
           join teams t on t.id = s.team_id
           left join cohort_ideas i on i.id = s.idea_id
           left join assessment_jobs j on j.submission_id = s.id
           left join assessment_summaries sum on sum.job_id = j.id
           left join ranking_snapshots rs on rs.cohort_id = s.cohort_id and rs.is_current
           left join ranking_entries re on re.snapshot_id = rs.id and re.submission_id = s.id
          where s.cohort_id = $1
            and ($2::submission_status is null or s.status = $2::submission_status)
            and ($3::text is null or j.stage::text = $3)
            and (
              $4::text is null
              or t.lead_name ilike '%' || $4 || '%'
              or t.lead_email::text ilike '%' || $4 || '%'
              or coalesce(s.product_name, '') ilike '%' || $4 || '%'
              or t.group_number::text = $4
            )
          order by t.group_number`,
        [cohortId, filter?.status ?? null, filter?.stage ?? null, filter?.search?.trim() || null],
      );

      return rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          submission: mapSubmission(row),
          team: {
            id: row.t_id,
            cohortId: row.t_cohort_id,
            groupNumber: toNumber(row.group_number),
            leadName: row.lead_name,
            leadEmail: row.lead_email,
            leadPhone: row.lead_phone,
            status: row.t_status,
            importedAt: row.imported_at,
            createdAt: row.t_created_at,
            updatedAt: row.t_updated_at,
          } as Team,
          ideaTitle: (row.idea_title as string | null) ?? null,
          stage: (row.stage as SubmissionListItem['stage']) ?? null,
          totalScore: row.total_score === null ? null : toNumber(row.total_score),
          meanConfidence: row.mean_confidence === null ? null : toNumber(row.mean_confidence),
          lowConfidence: Boolean(row.low_confidence),
          rank: row.rank === null ? null : toNumber(row.rank),
          inShortlist: Boolean(row.in_shortlist),
          hasOpenManualReview: Boolean(row.has_open_manual_review),
          disqualificationStatus:
            (row.disqualification_status as SubmissionListItem['disqualificationStatus']) ?? 'none',
        } satisfies SubmissionListItem;
      });
    },

    async getSubmission(id) {
      const { rows } = await db.query(
        `select ${SUBMISSION_COLUMNS} from submissions s where s.id = $1`,
        [id],
      );
      return rows.length > 0 ? mapSubmission(rows[0] as Record<string, unknown>) : null;
    },

    async findByReceiptId(receiptId) {
      // Case-insensitive: a team quotes this out of a PDF or a chat message,
      // and refusing on case would be an unhelpful way to be correct.
      const { rows } = await db.query(
        `select ${SUBMISSION_COLUMNS} from submissions s where upper(s.receipt_id) = upper($1)`,
        [receiptId],
      );
      return rows.length > 0 ? mapSubmission(rows[0] as Record<string, unknown>) : null;
    },

    async listTeamActivity(submissionId) {
      const { rows } = await db.query(
        'select * from team_activity where submission_id = $1 order by created_at desc',
        [submissionId],
      );
      return mapRows<TeamActivity>(rows);
    },

    async revokeTeamSessions(teamId) {
      const { rows } = await db.query(
        `update participant_sessions set revoked_at = now()
          where team_id = $1 and revoked_at is null
          returning id`,
        [teamId],
      );
      return rows.length;
    },

    async getSubmissionDetail(id): Promise<AdminSubmissionDetail | null> {
      const submission = await this.getSubmission(id);
      if (!submission) return null;

      const [team, cohort, idea, artifacts, declarations, credentials, events, auditLogs] =
        await Promise.all([
          db.query('select * from teams where id = $1', [submission.teamId]),
          loadCohort(db, submission.cohortId),
          submission.ideaId
            ? db.query('select * from cohort_ideas where id = $1', [submission.ideaId])
            : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
          db.query(
            'select * from submission_artifacts where submission_id = $1 order by created_at',
            [id],
          ),
          db.query('select * from submission_declarations where submission_id = $1', [id]),
          db.query(
            'select * from submission_credentials where submission_id = $1 and deleted_at is null',
            [id],
          ),
          db.query('select * from submission_events where submission_id = $1 order by created_at', [
            id,
          ]),
          db.query(
            `select * from audit_logs
              where entity_type = 'submission' and entity_id = $1
              order by created_at desc limit 50`,
            [id],
          ),
        ]);

      const teamRow = mapMaybe<Team>(team.rows);
      if (!teamRow || !cohort) return null;

      const members = await db.query(
        'select * from team_members where team_id = $1 order by display_order',
        [teamRow.id],
      );

      // Assessment sections. Empty until Phase B — the page renders "not
      // assessed yet" rather than failing, which is what keeps the admin
      // surface usable while judging is unavailable.
      const assessment = await loadAssessmentSections(db, id);

      return {
        submission,
        team: teamRow,
        members: mapRows<TeamMember>(members.rows),
        cohort,
        idea:
          idea.rows.length > 0 ? mapIdeaRow(idea.rows[0] as Record<string, unknown>) : null,
        artifacts: mapRowsWithNumbers<SubmissionArtifact>(artifacts.rows, ARTIFACT_NUMERIC_COLUMNS),
        declarations: mapMaybe<SubmissionDeclarations>(declarations.rows),
        credentials: mapMaybe<SubmissionCredentials>(credentials.rows),
        events: events.rows.map((row) => {
          const event = mapRow<SubmissionEvent>(row);
          return { ...event, detail: parseJson<Record<string, unknown>>(event.detail, {}) };
        }),
        auditLogs: auditLogs.rows.map((row) => {
          const entry = mapRow<AuditLog>(row);
          return {
            ...entry,
            before: parseJson<Record<string, unknown> | null>(entry.before, null),
            after: parseJson<Record<string, unknown> | null>(entry.after, null),
          };
        }),
        ...assessment,
      };
    },

    async reopenSubmission(id, reason) {
      return db.transaction(async (tx) => {
        // The receipt id is deliberately NOT cleared. A team that has been given
        // an identifier keeps it; reopening changes what they may edit, not what
        // they were told.
        const { rows } = await tx.query(
          `update submissions
              set status = 'reopened',
                  reopened_at = now(),
                  reopened_reason = $2,
                  locked_at = null,
                  version = version + 1
            where id = $1
            returning ${SUBMISSION_RETURNING}`,
          [id, reason],
        );
        if (rows.length === 0) throw new RowNotFoundError('Submission', id);

        await tx.query(
          `insert into submission_events (submission_id, event_type, actor_type, detail)
           values ($1, 'reopened', 'shared-admin', $2)`,
          [id, json({ reason })],
        );

        return mapSubmission(rows[0] as Record<string, unknown>);
      });
    },

    async lockSubmission(id) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `update submissions
              set status = 'locked', locked_at = now(), version = version + 1
            where id = $1
            returning ${SUBMISSION_RETURNING}`,
          [id],
        );
        if (rows.length === 0) throw new RowNotFoundError('Submission', id);

        await tx.query(
          `insert into submission_events (submission_id, event_type, actor_type, detail)
           values ($1, 'locked', 'shared-admin', '{}'::jsonb)`,
          [id],
        );
        return mapSubmission(rows[0] as Record<string, unknown>);
      });
    },

    async setLateException(id, granted, reason) {
      return db.transaction(async (tx) => {
        // Lateness itself is a computed fact and is never edited. This records
        // the separate, reversible decision about whether it counts (ADR-016).
        const { rows } = await tx.query(
          `update submissions set has_late_exception = $2 where id = $1
           returning ${SUBMISSION_RETURNING}`,
          [id, granted],
        );
        if (rows.length === 0) throw new RowNotFoundError('Submission', id);

        await tx.query(
          `insert into submission_events (submission_id, event_type, actor_type, detail)
           values ($1, $2, 'shared-admin', $3)`,
          [id, granted ? 'late_exception_granted' : 'late_exception_revoked', json({ reason })],
        );
        return mapSubmission(rows[0] as Record<string, unknown>);
      });
    },

    async getCredentials(submissionId) {
      // The record, not the values. Ciphertext columns come back as bytea and
      // are rendered as opaque strings; nothing here decrypts.
      const { rows } = await db.query(
        'select * from submission_credentials where submission_id = $1 and deleted_at is null',
        [submissionId],
      );
      const record = mapMaybe<SubmissionCredentials>(rows);
      if (!record) return null;
      return {
        ...record,
        usernameCiphertext: bufferToText(record.usernameCiphertext),
        passwordCiphertext: bufferToText(record.passwordCiphertext),
        loginInstructionsCiphertext: bufferToText(record.loginInstructionsCiphertext),
      };
    },

    async revealCredentials(submissionId) {
      const { rows } = await db.query(
        `select username_ciphertext, password_ciphertext, login_instructions_ciphertext
           from submission_credentials
          where submission_id = $1 and deleted_at is null`,
        [submissionId],
      );
      if (rows.length === 0) return null;

      const row = rows[0] as {
        username_ciphertext: unknown;
        password_ciphertext: unknown;
        login_instructions_ciphertext: unknown;
      };
      const key = parseEncryptionKey(deps.credentialKey);

      // Each field carries its own IV and auth tag inside its envelope, so a
      // tampered ciphertext throws here rather than returning plausible rubbish.
      const open = (value: unknown): string => {
        const serialised = bufferToText(value);
        if (!serialised) return '';
        return decryptSecret(deserialiseEnvelope(serialised), key);
      };

      // Stamped so an unexplained reveal is visible afterwards. The caller
      // writes the audit entry; this records that it happened at all.
      await db.query(
        'update submission_credentials set last_revealed_at = now() where submission_id = $1',
        [submissionId],
      );

      return {
        username: open(row.username_ciphertext),
        password: open(row.password_ciphertext),
        loginInstructions: open(row.login_instructions_ciphertext),
      };
    },

    async deleteCredentials(submissionId) {
      // Overwrites the ciphertext rather than only setting a flag. Retention
      // means the values are gone, not hidden.
      await db.query(
        `update submission_credentials
            set username_ciphertext = null,
                password_ciphertext = null,
                login_instructions_ciphertext = null,
                deleted_at = now(),
                updated_at = now()
          where submission_id = $1`,
        [submissionId],
      );
    },

    async listArtifacts(submissionId) {
      const { rows } = await db.query(
        'select * from submission_artifacts where submission_id = $1 order by created_at',
        [submissionId],
      );
      return mapRowsWithNumbers<SubmissionArtifact>(rows, ARTIFACT_NUMERIC_COLUMNS);
    },

    async getDeclarations(submissionId) {
      const { rows } = await db.query(
        'select * from submission_declarations where submission_id = $1',
        [submissionId],
      );
      return mapMaybe<SubmissionDeclarations>(rows);
    },

    async listEvents(submissionId) {
      const { rows } = await db.query(
        'select * from submission_events where submission_id = $1 order by created_at',
        [submissionId],
      );
      return rows.map((row) => {
        const event = mapRow<SubmissionEvent>(row);
        return { ...event, detail: parseJson<Record<string, unknown>>(event.detail, {}) };
      });
    },
  };
}

// --------------------------------------------------------------------------

/**
 * Read a `bytea` column as text.
 *
 * `pg` returns a Buffer; PGlite returns a plain Uint8Array. Calling
 * `.toString('utf8')` on the latter silently yields comma-separated byte
 * numbers rather than failing, so the conversion has to be explicit.
 */
function bufferToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

function mapIdeaRow(row: Record<string, unknown>): CohortIdea {
  const idea = mapRow<CohortIdea>(row);
  return {
    ...idea,
    minimumCoreFlow: parseJson<string[]>(idea.minimumCoreFlow, []),
    expectedEntities: (idea.expectedEntities as string[] | null) ?? [],
  };
}

/**
 * The assessment half of the detail view.
 *
 * Real reads against real tables. Until Phase B populates them they return
 * nothing, which renders as "not assessed yet" — the page stays usable, and no
 * placeholder or synthetic score is ever produced to fill the space.
 */
async function loadAssessmentSections(
  db: SqlDatabase,
  submissionId: string,
): Promise<
  Pick<
    AdminSubmissionDetail,
    | 'job'
    | 'preflight'
    | 'artifactAnalysis'
    | 'testPlan'
    | 'browserRuns'
    | 'evidence'
    | 'scores'
    | 'summary'
    | 'consistencyReviews'
    | 'manualReviewFlags'
    | 'disqualifications'
    | 'feedbackReport'
    | 'rank'
    | 'inShortlist'
  >
> {
  const jobRows = await db.query('select * from assessment_jobs where submission_id = $1', [
    submissionId,
  ]);
  const job = mapMaybe<AdminSubmissionDetail['job']>(jobRows.rows);

  const [flags, disqualifications, feedback, ranking] = await Promise.all([
    db.query('select * from manual_review_flags where submission_id = $1 order by created_at', [
      submissionId,
    ]),
    db.query('select * from disqualifications where submission_id = $1 order by created_at', [
      submissionId,
    ]),
    db.query('select * from feedback_reports where submission_id = $1', [submissionId]),
    db.query(
      `select re.rank, re.in_shortlist
         from ranking_entries re
         join ranking_snapshots rs on rs.id = re.snapshot_id and rs.is_current
        where re.submission_id = $1`,
      [submissionId],
    ),
  ]);

  const rankRow = ranking.rows[0] as { rank: number; in_shortlist: boolean } | undefined;

  if (!job) {
    return {
      job: null,
      preflight: [],
      artifactAnalysis: null,
      testPlan: null,
      browserRuns: [],
      evidence: [],
      scores: [],
      summary: null,
      consistencyReviews: [],
      manualReviewFlags: mapRows(flags.rows),
      disqualifications: mapRows(disqualifications.rows),
      feedbackReport: feedback.rows[0] ? mapFeedback(feedback.rows[0]) : null,
      rank: rankRow ? toNumber(rankRow.rank) : null,
      inShortlist: Boolean(rankRow?.in_shortlist),
    };
  }

  const [preflight, analysis, plan, runs, evidence, scores, summary, reviews] = await Promise.all([
    db.query('select * from preflight_checks where job_id = $1 order by checked_at', [job.id]),
    db.query('select * from artifact_analyses where job_id = $1', [job.id]),
    db.query('select * from test_plans where job_id = $1', [job.id]),
    db.query('select * from browser_test_runs where job_id = $1 order by started_at', [job.id]),
    db.query('select * from assessment_evidence where job_id = $1 order by created_at', [job.id]),
    db.query('select * from category_scores where job_id = $1 order by category_key', [job.id]),
    db.query('select * from assessment_summaries where job_id = $1', [job.id]),
    db.query('select * from consistency_reviews where job_id = $1 order by reviewed_at', [job.id]),
  ]);

  const planRow = mapMaybe<AdminSubmissionDetail['testPlan']>(plan.rows);
  const planSteps = planRow
    ? await db.query('select * from test_plan_steps where test_plan_id = $1 order by step_index', [
        planRow.id,
      ])
    : { rows: [] as Record<string, unknown>[] };

  const browserRuns = await Promise.all(
    mapRows<AdminSubmissionDetail['browserRuns'][number]>(runs.rows).map(async (run) => {
      const steps = await db.query(
        'select * from browser_test_steps where run_id = $1 order by step_index',
        [run.id],
      );
      return { ...run, steps: mapRows<AdminSubmissionDetail['browserRuns'][number]['steps'][number]>(steps.rows) };
    }),
  );

  return {
    job,
    preflight: mapRows(preflight.rows),
    artifactAnalysis: mapMaybe(analysis.rows),
    testPlan: planRow ? { ...planRow, steps: mapRows(planSteps.rows) } : null,
    browserRuns,
    /*
     * Mapped by the same functions the worker reads these tables with.
     *
     * `mapRows` renames columns and does nothing else, so every `numeric`
     * column arrived here as the string Postgres sends — `total_score` as
     * "56.00" rather than 56. The scores tab calls `.toFixed(2)` on those, and
     * a string has no `toFixed`, so opening that tab threw and Next replaced
     * the entire page with "a client-side exception has occurred". Every
     * completed submission was affected; nothing about the data was unusual.
     */
    evidence: evidence.rows.map(mapEvidence),
    scores: scores.rows.map(mapScore),
    summary: summary.rows[0] ? mapSummary(summary.rows[0]) : null,
    consistencyReviews: reviews.rows.map(mapConsistencyReview),
    manualReviewFlags: mapRows(flags.rows),
    disqualifications: mapRows(disqualifications.rows),
    feedbackReport: feedback.rows[0] ? mapFeedback(feedback.rows[0]) : null,
    rank: rankRow ? toNumber(rankRow.rank) : null,
    inShortlist: Boolean(rankRow?.in_shortlist),
  };
}
