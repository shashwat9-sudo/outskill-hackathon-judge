/**
 * Repositories that are not implemented yet.
 *
 * The submission platform ships before automated judging (Phase A / Phase B).
 * The `DataStore` interface still has to be satisfied structurally, and the
 * dangerous way to do that is a stub that returns `[]` or `null` — the admin UI
 * would render an empty queue, a zero score and an empty shortlist, all of which
 * look like real answers.
 *
 * So every method throws a specific, named error, and the store advertises what
 * it cannot do through `capabilities`. Callers check the capability and show a
 * production-safe message; anything that calls through anyway fails loudly
 * rather than quietly inventing an assessment result.
 */

import type { AssessmentStore, RankingStore } from '../store';

export class FeatureUnavailableError extends Error {
  override readonly name = 'FeatureUnavailableError';
  constructor(readonly feature: string, method: string) {
    super(
      `${feature} is not available in this deployment yet (called ${method}). ` +
        'Final submissions are stored safely and remain available until it is enabled.',
    );
  }
}

/** What a store can actually do. Read this instead of catching an error. */
export interface StoreCapabilities {
  /** Automated assessment: queue, browser testing, scoring, feedback. */
  assessment: boolean;
  /** Ranking, private shortlist and final selection. */
  ranking: boolean;
}

export const ALL_CAPABILITIES: StoreCapabilities = { assessment: true, ranking: true };

/**
 * Build an object whose every method throws.
 *
 * Generated from the method-name list rather than written out, so a method
 * added to the interface later cannot be silently missing here — the type
 * checker requires the record to be exhaustive.
 */
function unavailable<T extends object>(feature: string, methods: readonly (keyof T)[]): T {
  const store = {} as Record<string | symbol, unknown>;
  for (const method of methods) {
    store[method as string] = () => {
      throw new FeatureUnavailableError(feature, String(method));
    };
  }
  return store as T;
}

const ASSESSMENT_METHODS = [
  'enqueueCohort',
  'enqueueSubmission',
  'getJob',
  'getJobBySubmission',
  'listJobs',
  'claimJobs',
  'heartbeat',
  'advanceStage',
  'releaseJob',
  'reclaimExpiredLeases',
  'recordPreflight',
  'listPreflight',
  'saveArtifactAnalysis',
  'saveTestPlan',
  'getTestPlan',
  'saveBrowserRun',
  'listBrowserRuns',
  'saveEvidence',
  'listEvidence',
  'saveScores',
  'listScores',
  'overrideScore',
  'saveSummary',
  'getSummary',
  'saveConsistencyReview',
  'saveFeedbackReport',
  'getFeedbackReport',
  'raiseManualReview',
  'resolveManualReview',
  'listManualReviewFlags',
  'proposeDisqualification',
  'confirmDisqualification',
  'reverseDisqualification',
  'listDisqualifications',
  'getQueueStats',
  'setFeedbackStatus',
  'listJobsNeedingFeedback',
  'listPendingFeedbackJobs',
  'getFeedbackCoverage',
  'supersedeSystemManualReview',
] as const satisfies readonly (keyof AssessmentStore)[];

const RANKING_METHODS = [
  'generateSnapshot',
  'getCurrentSnapshot',
  'listSnapshots',
  'listFinalSelections',
  'setFinalSelection',
  'clearFinalSelection',
  'listRankedResults',
] as const satisfies readonly (keyof RankingStore)[];

export function unavailableAssessmentStore(): AssessmentStore {
  return unavailable<AssessmentStore>('Automated judging', ASSESSMENT_METHODS);
}

export function unavailableRankingStore(): RankingStore {
  return unavailable<RankingStore>('Ranking and shortlisting', RANKING_METHODS);
}

/** The message an operator should see where judging would normally appear. */
export const JUDGING_UNAVAILABLE_MESSAGE =
  'Automated judging is not configured yet. Final submissions are stored safely and will remain available until judging is enabled.';
