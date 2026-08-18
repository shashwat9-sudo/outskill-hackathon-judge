/**
 * Submission mapping shared by the participant and admin repositories.
 *
 * `is_late` is not a column — `0001` defines it as `submission_is_late(sub)`,
 * because lateness is a computed fact rather than stored state (ADR-016).
 * Every select therefore has to call it, which is why there is one column list
 * here instead of `select *` scattered around.
 */

import type { Submission } from '../../types';
import { mapRow, parseJson } from '../rows';

/**
 * Columns for any submission read.
 *
 * The table must be aliased `s` (or referenced unqualified) for the computed
 * column to resolve.
 */
export const SUBMISSION_COLUMNS = `s.*, submission_is_late(s.*) as is_late`;

/** Same list for a statement with no alias, e.g. an `update ... returning`. */
export const SUBMISSION_RETURNING = `submissions.*, submission_is_late(submissions.*) as is_late`;

export function mapSubmission(row: Record<string, unknown>): Submission {
  const submission = mapRow<Submission>(row);
  return {
    ...submission,
    // jsonb columns. `text[]` arrives as a real array and needs no parsing.
    draftPayload: parseJson<Record<string, unknown>>(submission.draftPayload, {}),
    coreTestSteps: parseJson<Submission['coreTestSteps']>(submission.coreTestSteps, []),
    bugsFixed: parseJson<Submission['bugsFixed']>(submission.bugsFixed, []),
    shouldHaveFeatures: (submission.shouldHaveFeatures as string[] | null) ?? [],
    isLate: Boolean(submission.isLate),
  };
}

/**
 * Copy draft fields onto the promoted columns.
 *
 * The draft blob is what the form round-trips; the columns are what judging,
 * exports and admin screens read. Identical to the memory driver's promotion,
 * because a submission must look the same whichever driver stored it.
 *
 * Returns a new object rather than mutating, so a caller cannot accidentally
 * persist a half-promoted record.
 */
export function promoteDraftToColumns(submission: Submission): Submission {
  const draft = submission.draftPayload as Record<string, Record<string, unknown> | undefined>;
  const product = draft.product ?? {};
  const live = draft.live ?? {};
  const learning = draft.learning ?? {};

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const next: Submission = { ...submission };

  next.ideaId = str(product.ideaId) ?? next.ideaId;
  next.productName = str(product.productName) ?? next.productName;
  next.primaryUser = str(product.primaryUser) ?? next.primaryUser;
  next.exactProblem = str(product.exactProblem) ?? next.exactProblem;
  next.oneSentencePromise = str(product.oneSentencePromise) ?? next.oneSentencePromise;
  next.briefDescription = str(product.briefDescription) ?? next.briefDescription;
  next.whyAiNecessary = str(product.whyAiNecessary) ?? next.whyAiNecessary;
  next.differentiation = str(product.differentiation) ?? next.differentiation;
  next.mustHaveWorkflow = str(product.mustHaveWorkflow) ?? next.mustHaveWorkflow;
  next.excludedFeatures = str(product.excludedFeatures) ?? next.excludedFeatures;
  if (Array.isArray(product.shouldHaveFeatures)) {
    next.shouldHaveFeatures = product.shouldHaveFeatures.filter(
      (f): f is string => typeof f === 'string',
    );
  }

  next.productUrl = str(live.productUrl) ?? next.productUrl;
  if (typeof live.loginRequired === 'boolean') next.loginRequired = live.loginRequired;
  next.safeSampleInputs = str(live.safeSampleInputs) ?? next.safeSampleInputs;
  next.resetInstructions = str(live.resetInstructions) ?? next.resetInstructions;
  next.knownLimitations = str(live.knownLimitations) ?? next.knownLimitations;
  if (Array.isArray(live.coreTestSteps)) {
    next.coreTestSteps = live.coreTestSteps
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      .map((s) => ({
        action: String(s.action ?? ''),
        expectedResult: String(s.expectedResult ?? ''),
      }));
  }

  next.deliberatelyExcluded = str(learning.deliberatelyExcluded) ?? next.deliberatelyExcluded;
  next.majorTradeoff = str(learning.majorTradeoff) ?? next.majorTradeoff;
  next.day12ToDay13Changes = str(learning.day12ToDay13Changes) ?? next.day12ToDay13Changes;
  next.mostImportantLearning = str(learning.mostImportantLearning) ?? next.mostImportantLearning;
  next.nextSevenDayPlan = str(learning.nextSevenDayPlan) ?? next.nextSevenDayPlan;
  next.builderStack = str(learning.builderStack) ?? next.builderStack;
  next.apisUsed = str(learning.apisUsed) ?? next.apisUsed;
  next.externalTemplates = str(learning.externalTemplates) ?? next.externalTemplates;
  if (Array.isArray(learning.bugsFixed)) {
    next.bugsFixed = learning.bugsFixed
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map((b) => ({
        description: String(b.description ?? ''),
        howFixed: String(b.howFixed ?? ''),
      }));
  }

  return next;
}
