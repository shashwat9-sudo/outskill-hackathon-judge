/**
 * Ranking, the private shortlist, and the final four.
 *
 * The output of this file is never shown to a participant. There is no
 * participant route that reads these tables and no method on `ParticipantStore`
 * that could reach them (ADR-010) — a team learning it was ranked 11th would
 * turn an internal working order into a public verdict Outskill never issued.
 *
 * Two properties matter more than anything else here:
 *
 *   **A snapshot is immutable.** Ranking is generated, stored, and then read.
 *   It is not recomputed on view. Two people looking at "the Top 10" on the
 *   same evening must see the same ten, and a list that silently reorders
 *   because a score changed between page loads is not a decision record.
 *
 *   **The final four are chosen by people.** `setFinalSelection` is reachable
 *   only from an admin action; no worker, stage, or model response has a call
 *   path to it (ADR-018). The system ranks. It does not declare winners.
 */

import type {
  FinalSelection,
  RankingEntry,
  RankingSnapshot,
} from '../../types';
import type { RankedListItem, RankingStore } from '../../store';
import { RowNotFoundError, type SqlClient, type SqlDatabase } from '../client';
import { json, mapRow, parseJson, toDate, toNumber } from '../rows';
import { isEligibleForRanking } from '../../../domain/disqualification';
import { rankSubmissions, type RankableSubmission } from '../../../domain/ranking';
import { RUBRIC_VERSION, RUBRIC_CATEGORIES } from '../../../rubric/index';
import { validateFinalSelection } from '../../../domain/ranking';

export function buildRankingStore(db: SqlDatabase): RankingStore {
  return {
    /**
     * Generate a ranking snapshot.
     *
     * Eligibility is decided explicitly and per submission rather than inside
     * the sort, so "why is this team not in the list" has an answer that names
     * a rule instead of requiring someone to re-derive the ordering.
     *
     * A submission missing any category score is excluded rather than ranked on
     * a partial total. Summing seven of eight categories produces a number that
     * looks like a score and is really a penalty for the system's own
     * incomplete work.
     */
    async generateSnapshot(cohortId, notes) {
      return db.transaction(async (tx) => {
        const cohort = await tx.query<{ shortlist_target: unknown }>(
          'select shortlist_target from cohorts where id = $1',
          [cohortId],
        );
        if (!cohort.rows[0]) throw new RowNotFoundError('cohort', cohortId);
        const shortlistTarget = toNumber(cohort.rows[0].shortlist_target, 10);

        const candidates = await collectRankable(tx, cohortId);
        const ranked = rankSubmissions(candidates, { shortlistTarget });

        // Exactly one current snapshot per cohort — the partial unique index
        // would reject a second, so the old one is stood down first.
        await tx.query(
          'update ranking_snapshots set is_current = false where cohort_id = $1 and is_current',
          [cohortId],
        );

        const { rows } = await tx.query(
          `insert into ranking_snapshots
             (cohort_id, rubric_version, eligible_count, shortlist_target, is_current, notes)
           values ($1, $2, $3, $4, true, $5)
           returning *`,
          [cohortId, RUBRIC_VERSION, ranked.length, shortlistTarget, notes ?? null],
        );
        const snapshot = mapSnapshot(rows[0]!);

        for (const entry of ranked) {
          await tx.query(
            `insert into ranking_entries
               (snapshot_id, submission_id, rank, total_score, tiebreak_vector,
                in_shortlist, mean_confidence)
             values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [
              snapshot.id,
              entry.submissionId,
              entry.rank,
              entry.totalScore,
              json(entry.tiebreakVector),
              entry.inShortlist,
              entry.meanConfidence,
            ],
          );
        }

        return snapshot;
      });
    },

    /**
     * Read the current snapshot.
     *
     * Returns the stored ordering, not a fresh computation. `lowConfidence` and
     * `hasOpenManualReview` travel with each row so the shortlist can be read
     * with its caveats attached — a rank whose evidence was thin should not
     * look identical to one that was thoroughly established.
     */
    async getCurrentSnapshot(cohortId) {
      const { rows } = await db.query(
        'select * from ranking_snapshots where cohort_id = $1 and is_current limit 1',
        [cohortId],
      );
      if (!rows[0]) return null;
      const snapshot = mapSnapshot(rows[0]);

      const entryRows = await db.query<Record<string, unknown>>(
        `select e.*,
                t.group_number,
                s.product_name,
                i.title as idea_title,
                coalesce(sum.low_confidence, false) as low_confidence,
                exists (
                  select 1 from manual_review_flags f
                   where f.submission_id = e.submission_id and f.status = 'open'
                ) as has_open_manual_review
           from ranking_entries e
           join submissions s on s.id = e.submission_id
           join teams t on t.id = s.team_id
           left join cohort_ideas i on i.id = s.idea_id
           left join assessment_jobs j on j.submission_id = e.submission_id
           left join assessment_summaries sum on sum.job_id = j.id
          where e.snapshot_id = $1
          order by e.rank`,
        [snapshot.id],
      );

      const entries: RankedListItem[] = entryRows.rows.map((row) => ({
        entry: mapEntry(row),
        submissionId: String(row.submission_id),
        groupNumber: toNumber(row.group_number),
        productName: (row.product_name as string | null) ?? null,
        ideaTitle: (row.idea_title as string | null) ?? null,
        lowConfidence: Boolean(row.low_confidence),
        hasOpenManualReview: Boolean(row.has_open_manual_review),
      }));

      return { ...snapshot, entries };
    },

    async listSnapshots(cohortId) {
      const { rows } = await db.query(
        'select * from ranking_snapshots where cohort_id = $1 order by generated_at desc',
        [cohortId],
      );
      return rows.map(mapSnapshot);
    },

    async listFinalSelections(cohortId) {
      const { rows } = await db.query<Record<string, unknown>>(
        `select f.*, t.group_number, s.product_name
           from final_selections f
           join submissions s on s.id = f.submission_id
           join teams t on t.id = s.team_id
          where f.cohort_id = $1
          order by f.position`,
        [cohortId],
      );
      return rows.map((row) => ({
        ...mapFinalSelection(row),
        groupNumber: toNumber(row.group_number),
        productName: (row.product_name as string | null) ?? null,
      }));
    },

    /**
     * Record the final four.
     *
     * Finalists must come from the current ranking snapshot. That is the
     * eligibility rule, not merely "belongs to this cohort": a submission that
     * was disqualified, or whose assessment never completed, is absent from the
     * snapshot and therefore cannot be seated — which is the whole reason the
     * snapshot is generated before anyone chooses.
     *
     * Replaced wholesale inside one transaction rather than patched. A partial
     * update could leave three finalists from one decision and one from an
     * earlier one, with nothing in the rows to show it had happened.
     *
     * `actor` is always a human. No worker, stage or model response has a call
     * path to this method (ADR-018).
     */
    async setFinalSelection(cohortId, selections, actor) {
      return db.transaction(async (tx) => {
        const { rows: snapshotRows } = await tx.query<{ id: string }>(
          'select id from ranking_snapshots where cohort_id = $1 and is_current limit 1',
          [cohortId],
        );
        const snapshotId = snapshotRows[0]?.id;
        if (!snapshotId) {
          throw new Error(
            'There is no current ranking for this cohort, so there is nothing to select from. Generate a ranking first.',
          );
        }

        const { rows: eligibleRows } = await tx.query<{ submission_id: string }>(
          'select submission_id from ranking_entries where snapshot_id = $1',
          [snapshotId],
        );
        const eligible = new Set(eligibleRows.map((r) => r.submission_id));

        const validation = validateFinalSelection(
          selections.map((s) => ({ submissionId: s.submissionId, position: s.position })),
          eligible,
        );
        if (!validation.valid) {
          throw new Error(`Final selection rejected: ${validation.problems.join(' ')}`);
        }

        await tx.query('delete from final_selections where cohort_id = $1', [cohortId]);

        const saved: FinalSelection[] = [];
        for (const selection of selections) {
          const { rows } = await tx.query(
            `insert into final_selections
               (cohort_id, submission_id, position, selected_by, selection_reason)
             values ($1, $2, $3, $4, $5)
             returning *`,
            [
              cohortId,
              selection.submissionId,
              selection.position,
              actor,
              selection.reason ?? '',
            ],
          );
          saved.push(mapFinalSelection(rows[0]!));
        }
        return saved;
      });
    },

    async clearFinalSelection(cohortId) {
      await db.query('delete from final_selections where cohort_id = $1', [cohortId]);
    },
  };
}

// --------------------------------------------------------------------------

/**
 * Gather what can be ranked.
 *
 * One statement per relation rather than a join producing a row per score: a
 * 500-submission cohort with eight categories each would otherwise return
 * 4,000 rows to be regrouped in memory.
 */
async function collectRankable(tx: SqlClient, cohortId: string): Promise<RankableSubmission[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `select s.id as submission_id,
            s.status,
            j.id as job_id,
            exists (
              select 1 from disqualifications d
               where d.submission_id = s.id and d.status = 'confirmed'
            ) as disqualified,
            (
              select count(*) from manual_review_flags f
               where f.submission_id = s.id and f.status = 'open'
            ) as open_flags
       from submissions s
       left join assessment_jobs j on j.submission_id = s.id
      where s.cohort_id = $1`,
    [cohortId],
  );
  if (rows.length === 0) return [];

  const jobIds = rows.map((r) => r.job_id).filter((id): id is string => typeof id === 'string');
  const scoreRows =
    jobIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query<Record<string, unknown>>(
          `select job_id, category_key, weighted_score, confidence
             from category_scores where job_id = any($1::uuid[])`,
          [jobIds],
        );

  const byJob = new Map<string, { categoryKey: string; weightedScore: number; confidence: number }[]>();
  for (const row of scoreRows.rows) {
    const jobId = String(row.job_id);
    const list = byJob.get(jobId) ?? [];
    list.push({
      categoryKey: String(row.category_key),
      weightedScore: toNumber(row.weighted_score),
      confidence: toNumber(row.confidence),
    });
    byJob.set(jobId, list);
  }

  const rankable: RankableSubmission[] = [];
  for (const row of rows) {
    const jobId = typeof row.job_id === 'string' ? row.job_id : null;
    const scores = jobId ? (byJob.get(jobId) ?? []) : [];

    // Every category must be present. A partial total is not a lower score, it
    // is an unfinished assessment, and ranking it would penalise a team for the
    // system's own gap.
    const hasCompleteScores = scores.length === RUBRIC_CATEGORIES.length;

    if (
      !isEligibleForRanking({
        submissionStatus: String(row.status),
        hasConfirmedDisqualification: Boolean(row.disqualified),
        hasCompleteScores,
      })
    ) {
      continue;
    }

    const meanConfidence =
      scores.reduce((sum, s) => sum + s.confidence, 0) / (scores.length || 1);

    rankable.push({
      submissionId: String(row.submission_id),
      scores: scores.map((s) => ({
        categoryKey: s.categoryKey as RankableSubmission['scores'][number]['categoryKey'],
        weightedScore: s.weightedScore,
      })),
      unresolvedRiskCount: toNumber(row.open_flags),
      meanConfidence,
    });
  }

  return rankable;
}

function mapSnapshot(row: Record<string, unknown>): RankingSnapshot {
  return {
    ...mapRow<RankingSnapshot>(row),
    eligibleCount: toNumber(row.eligible_count),
    shortlistTarget: toNumber(row.shortlist_target),
    generatedAt: toDate(row.generated_at) ?? new Date(),
  };
}

function mapEntry(row: Record<string, unknown>): RankingEntry {
  return {
    id: String(row.id),
    snapshotId: String(row.snapshot_id),
    submissionId: String(row.submission_id),
    rank: toNumber(row.rank),
    totalScore: toNumber(row.total_score),
    tiebreakVector: parseJson(row.tiebreak_vector, {}),
    inShortlist: Boolean(row.in_shortlist),
    meanConfidence: toNumber(row.mean_confidence),
  };
}

function mapFinalSelection(row: Record<string, unknown>): FinalSelection {
  return {
    ...mapRow<FinalSelection>(row),
    position: toNumber(row.position),
    selectedAt: toDate(row.selected_at) ?? new Date(),
  };
}
