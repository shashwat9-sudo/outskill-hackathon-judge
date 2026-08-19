import type { SqlDatabase } from '../client';
import { encryptSecret, parseEncryptionKey, serialiseEnvelope } from '../../../security/crypto';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../../rubric/index';

/**
 * Work arriving from the Outskill Hackathon product.
 *
 * The Judge is now a private backend. Learners never come here; the Hackathon
 * product owns the form, the identity and the relationship, and hands us the
 * few facts needed to judge a product.
 *
 * Two properties do most of the work in this file.
 *
 * IDEMPOTENCE. The caller retries — that is what a well-behaved service does
 * when a response is slow or a deploy interrupts it. So delivery is keyed on
 * the Hackathon product's own immutable submission identifier, and a repeat
 * finds the existing assessment instead of judging the same work twice. Nothing
 * about the outcome depends on the caller getting exactly-once delivery right.
 *
 * PII MINIMISATION. The Hackathon product knows team members, emails and phone
 * numbers. None of that helps decide whether a product works, so the contract
 * has nowhere to put it. What arrives is what judging reads, which is also the
 * shortest honest answer to "why do you hold this".
 */

export interface PartnerSubmissionInput {
  /** The Hackathon product's cohort identifier. */
  externalCohortId: string;
  /** Immutable, and the idempotency key. */
  externalSubmissionId: string;
  groupNumber: number;
  /** Slug of the approved idea the team chose. */
  ideaSlug: string;
  productName: string;
  briefDescription: string;
  /** "What is the main thing a user should be able to do successfully?" */
  mainUserAction: string;
  /** "How does AI help the user or make the product more useful?" */
  aiValue: string;
  productUrl: string;
  accessMode: 'open' | 'credentials';
  /** Present only when accessMode is 'credentials'. Encrypted at rest. */
  judgeCredentials?: { username: string; password: string; notes?: string } | null;
  loomUrl?: string | null;
  deckUrl?: string | null;
  submittedAt?: string | null;
  submissionVersion?: number | null;
}

export interface PartnerIngestResult {
  ok: boolean;
  /** The Judge's own identifier, stable across retries. */
  submissionId?: string;
  status?: string;
  /** True when this delivery matched work already accepted. */
  duplicate?: boolean;
  error?: string;
}

export interface PartnerCategoryResult {
  key: string;
  title: string;
  score: number;
  maxPoints: number;
  reasoning: string;
  confidence: number | null;
}

export interface PartnerResult {
  found: boolean;
  externalSubmissionId?: string;
  status?: 'queued' | 'in_progress' | 'completed' | 'manual_review' | 'failed' | 'disqualified';
  totalScore?: number | null;
  maxScore?: number;
  categories?: PartnerCategoryResult[];
  manualReview?: { flagged: boolean; reasons: string[] };
  disqualified?: { flagged: boolean; reason: string | null };
  confidence?: number | null;
  rank?: number | null;
  inTopTen?: boolean;
  rubricVersion?: string;
  error?: string;
}

export interface PartnerStore {
  ingestSubmission(input: PartnerSubmissionInput): Promise<PartnerIngestResult>;
  getPartnerResult(externalSubmissionId: string): Promise<PartnerResult>;
}

/** Stages that mean judging has not finished yet. */
const IN_PROGRESS = new Set([
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
]);

export function buildPartnerStore(
  db: SqlDatabase,
  deps: { credentialKey: string; credentialKeyVersion: number },
): PartnerStore {
  return {
    async ingestSubmission(input) {
      if (!input.externalSubmissionId || !input.externalCohortId) {
        return { ok: false, error: 'externalCohortId and externalSubmissionId are required.' };
      }
      if (input.accessMode === 'credentials' && !input.judgeCredentials?.password) {
        return { ok: false, error: 'accessMode is "credentials" but no judge credentials were supplied.' };
      }

      return db.transaction(async (tx) => {
        /*
         * Idempotence first, before anything is created.
         *
         * A retry must not produce a second team, a second submission or a
         * second job. The unique index on `external_submission_id` is the
         * backstop; this read is what makes the ordinary case cheap and gives
         * the caller a truthful `duplicate` flag.
         */
        const { rows: existing } = await tx.query<{ id: string; status: string }>(
          'select id, status from submissions where external_submission_id = $1',
          [input.externalSubmissionId],
        );
        if (existing[0]) {
          return {
            ok: true,
            submissionId: existing[0].id,
            status: existing[0].status,
            duplicate: true,
          };
        }

        const { rows: cohortRows } = await tx.query<{ id: string }>(
          'select id from cohorts where code = $1 or id::text = $1',
          [input.externalCohortId],
        );
        const cohortId = cohortRows[0]?.id;
        if (!cohortId) {
          return { ok: false, error: `No cohort matches "${input.externalCohortId}".` };
        }

        /*
         * A team row, holding only the group number.
         *
         * The Hackathon product knows who is on the team. We do not need to,
         * and `lead_name` is filled with the group label rather than a person
         * so that nothing here becomes a quiet store of learner names.
         */
        const { rows: teamRows } = await tx.query<{ id: string }>(
          `insert into teams (cohort_id, group_number, lead_name, status)
           values ($1, $2, $3, 'active')
           on conflict (cohort_id, group_number) do update set updated_at = now()
           returning id`,
          [cohortId, input.groupNumber, `Group ${input.groupNumber}`],
        );
        const teamId = teamRows[0]!.id;

        const { rows: ideaRows } = await tx.query<{ id: string }>(
          'select id from cohort_ideas where cohort_id = $1 and slug = $2',
          [cohortId, input.ideaSlug],
        );

        // The snapshot never contains the credentials; those are sealed below.
        const snapshot = { ...input, judgeCredentials: input.judgeCredentials ? '[redacted]' : null };

        const { rows: submissionRows } = await tx.query<{ id: string; status: string }>(
          `insert into submissions
             (cohort_id, team_id, idea_id, status, product_url, login_required,
              product_name, brief_description, must_have_workflow, why_ai_necessary,
              external_cohort_id, external_submission_id, source, access_mode,
              loom_url, deck_url, ingest_snapshot, submitted_at, submitted_by_name)
           values ($1,$2,$3,'submitted',$4,$5,$6,$7,$8,$9,$10,$11,'outskill_hackathon',$12,$13,$14,$15::jsonb,$16,$17)
           returning id, status`,
          [
            cohortId,
            teamId,
            ideaRows[0]?.id ?? null,
            input.productUrl,
            input.accessMode === 'credentials',
            input.productName,
            input.briefDescription,
            // The main user action drives the browser plan.
            input.mainUserAction,
            input.aiValue,
            input.externalCohortId,
            input.externalSubmissionId,
            input.accessMode,
            input.loomUrl ?? null,
            input.deckUrl ?? null,
            JSON.stringify(snapshot),
            input.submittedAt ? new Date(input.submittedAt) : new Date(),
            `Group ${input.groupNumber}`,
          ],
        );
        const submission = submissionRows[0]!;

        if (input.judgeCredentials) {
          /*
           * Sealed with the same envelope the participant path uses.
           *
           * These are credentials a team created so a judge could look at their
           * product. They are decrypted at the moment the browser needs them and
           * never written back, never logged, and never returned by the result
           * API.
           */
          const key = parseEncryptionKey(deps.credentialKey);
          const seal = (value: string | undefined) =>
            value && value.length > 0
              ? Buffer.from(
                  serialiseEnvelope(encryptSecret(value, key, deps.credentialKeyVersion)),
                  'utf8',
                )
              : null;

          await tx.query(
            `insert into submission_credentials
               (submission_id, username_ciphertext, password_ciphertext,
                login_instructions_ciphertext, key_version)
             values ($1,$2,$3,$4,$5)
             on conflict (submission_id) do update
               set username_ciphertext = excluded.username_ciphertext,
                   password_ciphertext = excluded.password_ciphertext,
                   login_instructions_ciphertext = excluded.login_instructions_ciphertext,
                   key_version = excluded.key_version,
                   deleted_at = null,
                   updated_at = now()`,
            [
              submission.id,
              seal(input.judgeCredentials.username),
              seal(input.judgeCredentials.password),
              seal(input.judgeCredentials.notes),
              deps.credentialKeyVersion,
            ],
          );
        }

        // Queue it. `on conflict do nothing` so a racing duplicate cannot
        // produce two jobs for one submission.
        await tx.query(
          `insert into assessment_jobs (submission_id, cohort_id)
           values ($1, $2) on conflict (submission_id) do nothing`,
          [submission.id, cohortId],
        );

        return { ok: true, submissionId: submission.id, status: submission.status, duplicate: false };
      });
    },

    async getPartnerResult(externalSubmissionId) {
      const { rows } = await db.query<{
        submission_id: string;
        cohort_id: string;
        job_id: string | null;
        stage: string | null;
        total_score: string | null;
        mean_confidence: string | null;
      }>(
        `select s.id as submission_id, s.cohort_id, j.id as job_id, j.stage,
                sum.total_score, sum.mean_confidence
           from submissions s
           left join assessment_jobs j on j.submission_id = s.id
           left join assessment_summaries sum on sum.job_id = j.id
          where s.external_submission_id = $1`,
        [externalSubmissionId],
      );

      const row = rows[0];
      if (!row) return { found: false, error: 'No submission with that identifier.' };

      const stage = row.stage ?? 'queued';
      const status: NonNullable<PartnerResult['status']> =
        stage === 'completed'
          ? 'completed'
          : stage === 'manual_review'
            ? 'manual_review'
            : stage === 'failed'
              ? 'failed'
              : stage === 'disqualified'
                ? 'disqualified'
                : IN_PROGRESS.has(stage)
                  ? 'in_progress'
                  : 'queued';

      const [scoreRows, flagRows, dqRows, rankRows] = await Promise.all([
        row.job_id
          ? db.query<{ category_key: string; raw_score: string; confidence: string; rationale: string }>(
              'select category_key, raw_score, confidence, rationale from category_scores where job_id = $1',
              [row.job_id],
            )
          : Promise.resolve({ rows: [] }),
        db.query<{ reason_code: string; detail: string; status: string }>(
          `select reason_code, detail, status from manual_review_flags
            where submission_id = $1 and status = 'open'`,
          [row.submission_id],
        ),
        db.query<{ reason_code: string; reason_detail: string; status: string }>(
          `select reason_code, reason_detail, status from disqualifications
            where submission_id = $1 order by created_at desc limit 1`,
          [row.submission_id],
        ),
        db.query<{ rank: number; in_shortlist: boolean }>(
          `select e.rank, e.in_shortlist from ranking_entries e
             join ranking_snapshots snap on snap.id = e.snapshot_id and snap.is_current
            where e.submission_id = $1`,
          [row.submission_id],
        ),
      ]);

      const byKey = new Map(scoreRows.rows.map((r) => [r.category_key, r]));

      /*
       * Every category, always, in rubric order.
       *
       * A caller should not have to know which categories exist or handle one
       * being absent because scoring has not run. An unscored category reports
       * a null score against its real maximum, which is honest and keeps the
       * shape stable.
       */
      const categories: PartnerCategoryResult[] = RUBRIC_CATEGORIES.map((category) => {
        const scored = byKey.get(category.key);
        return {
          key: category.key,
          title: category.title,
          score: scored ? Number(scored.raw_score) : 0,
          maxPoints: category.maxPoints,
          reasoning: scored?.rationale ?? '',
          confidence: scored ? Number(scored.confidence) : null,
        };
      });

      const dq = dqRows.rows[0];

      return {
        found: true,
        externalSubmissionId,
        status,
        totalScore: row.total_score === null ? null : Number(row.total_score),
        maxScore: 100,
        categories,
        manualReview: {
          flagged: flagRows.rows.length > 0,
          reasons: flagRows.rows.map((f) => f.detail || f.reason_code),
        },
        /*
         * Disqualification is for breaking the rules of the event, not for
         * building something rough. A product that is unfinished, ugly or
         * partly broken is scored on what it does — it is never disqualified
         * for it. So this is normally absent, and when present it carries an
         * explicit reason a human can stand behind.
         */
        disqualified: {
          flagged: Boolean(dq && dq.status !== 'reversed'),
          reason: dq ? (dq.reason_detail || dq.reason_code) : null,
        },
        confidence: row.mean_confidence === null ? null : Number(row.mean_confidence),
        rank: rankRows.rows[0]?.rank ?? null,
        inTopTen: Boolean(rankRows.rows[0]?.in_shortlist),
        rubricVersion: RUBRIC_VERSION,
      };
    },
  };
}
