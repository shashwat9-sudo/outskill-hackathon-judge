/**
 * The all-submissions audit export.
 *
 * "For every submitted product, what happened during judging, and if it did
 * not receive a rank, why?" — answered from the records the system already
 * holds, never by judging again.
 *
 * The results export (`results-export.ts`) is ranking-based: one row per entry
 * of the current snapshot. A product whose assessment failed, was diverted to a
 * human, or never got a job is not in that file because it is not in the
 * ranking. This module starts from the submissions instead, so every imported
 * product is a row exactly once, and composes whatever else exists around it
 * with the equivalent of left joins.
 *
 * Three rules govern the "why" columns.
 *
 * EVIDENCE BEFORE INFERENCE. The reason for a failure is taken from an
 * explicit record where one exists — the job's own error, a preflight check,
 * a browser run, a manual-review flag — and only otherwise derived from the
 * trail of stage records. Every row says which it was (`Reason Source`) and
 * how strong the support is (`Reason Evidence Quality`). Where nothing
 * recorded explains a failure, the file says "reason not recorded" rather
 * than offering a plausible story.
 *
 * MANUAL REVIEW IS NOT FAILURE. A completed, scored, ranked product with an
 * open low-confidence flag is `Completed` with `Manual Review = yes`. Only a
 * job whose stage is `manual_review` has the outcome "Needs human review".
 * Feedback is a separate lifecycle again: a failed feedback report never
 * changes the assessment outcome.
 *
 * BLANK IS NOT ZERO. A category the Judge never validly scored is an empty
 * cell. Zero means the Judge assessed the category and awarded nothing.
 *
 * Nothing secret can reach the file: `SubmissionAuditRow` has nowhere to carry
 * a credential, ciphertext, prompt or evidence path, and every free-text cell
 * that originates in an error message or a flag passes through
 * `sanitiseForExport`, which redacts anything shaped like a password, token,
 * key or connection string.
 */

import { RUBRIC_CATEGORIES, type RubricCategoryKey } from '../rubric/index';
import type { FailureClass, FeedbackReport, FeedbackStatus, PreflightStatus } from '../data/types';
import { isEligibleForRanking } from './disqualification';
import { ASSESSMENT_HAPPY_PATH, SUBMISSION_FINAL_STATUSES } from './status';
import { RESULTS_EXPORT_CATEGORY_LABELS, RESULTS_EXPORT_MAX_SCORE } from './results-export';
import { toCsv } from '../utils/csv';

// --------------------------------------------------------------------------
// The row
// --------------------------------------------------------------------------

export interface AuditPreflightCheck {
  checkKey: string;
  status: PreflightStatus;
  failureClass: FailureClass;
  /** `detail.message` as the preflight stage wrote it, or null. */
  message: string | null;
}

export interface AuditBrowserRun {
  attempt: number;
  viewport: string;
  status: 'passed' | 'partial' | 'failed' | 'error';
  timedOut: boolean;
  durationMs: number | null;
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  stepsErrored: number;
  /** A `navigate` step passed: the browser reached the product at all. */
  navigationPassed: boolean;
  firstFailure: { stepIndex: number; action: string; errorMessage: string | null } | null;
}

export interface AuditManualReviewFlag {
  reasonCode: string;
  detail: string;
  status: 'open' | 'resolved' | 'dismissed';
  raisedBy: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

export interface AuditCategoryScore {
  /** The effective score — the human override where one exists (ADR-012). */
  rawScore: number;
  maxPoints: number;
  confidence: number;
  isOverridden: boolean;
}

/** Everything the audit needs about one imported submission, and nothing secret. */
export interface SubmissionAuditRow {
  cohortId: string;
  cohortName: string;
  cohortCode: string;

  submissionId: string;
  groupNumber: number;
  productName: string | null;
  ideaTitle: string | null;
  ideaSlug: string | null;
  submissionStatus: string;
  loginRequired: boolean;
  productUrl: string | null;
  loomUrl: string | null;
  deckUrl: string | null;

  /** The cohort's configured threshold below which a category is "low confidence". */
  lowConfidenceThreshold: number | null;

  /** Null when the submission was never queued. */
  job: {
    id: string;
    stage: string;
    attemptCount: number;
    maxAttempts: number;
    lastError: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date | null;
  } | null;

  /** The most recent preflight attempt's checks, or null when none ran. */
  preflight: { attempt: number; checks: AuditPreflightCheck[] } | null;
  artifactAnalysis: {
    deckPageCount: number | null;
    deckTextExtracted: boolean;
    videoAnalysisLimited: boolean;
    videoLimitationReason: string | null;
    injectionFlagCount: number;
  } | null;
  testPlan: { stepCount: number; validationStatus: string; rejectedStepCount: number } | null;
  browserRuns: AuditBrowserRun[];
  evidenceCount: number;

  categoryScores: Partial<Record<RubricCategoryKey, AuditCategoryScore>>;
  summary: {
    totalScore: number;
    meanConfidence: number;
    minConfidence: number;
    lowConfidence: boolean;
    riskCount: number;
  } | null;

  manualReviewFlags: AuditManualReviewFlag[];
  disqualification: {
    status: 'proposed' | 'confirmed' | 'reversed';
    reasonCode: string;
    reasonDetail: string;
  } | null;

  /** The entry in the current ranking snapshot, as stored; null when unranked. */
  ranking: { rank: number; totalScore: number; inShortlist: boolean; meanConfidence: number } | null;
  rankingGeneratedAt: Date | null;

  finalPosition: number | null;
  finalSelectionReason: string | null;

  feedbackStatus: FeedbackStatus;
  feedbackError: string | null;
  feedbackAttempts: number;
  feedback: FeedbackReport | null;
}

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------

export const ASSESSMENT_OUTCOMES = [
  'Completed',
  'Needs human review',
  'Failed',
  'Disqualified',
  'In progress',
  'Queued',
  'Not assessed',
] as const;
export type AssessmentOutcome = (typeof ASSESSMENT_OUTCOMES)[number];

export const REASON_SOURCES = [
  'Explicit system error',
  'Preflight record',
  'Browser run record',
  'Test plan record',
  'Manual review flag',
  'Disqualification record',
  'Assessment job record',
  'Assessment event',
  'Worker log',
  'Derived from existing evidence',
  'Not recorded',
] as const;
export type ReasonSource = (typeof REASON_SOURCES)[number];

export type EvidenceQuality = 'High' | 'Medium' | 'Low' | 'Unknown';

export type FailureStageBasis = 'Explicitly recorded' | 'Derived from existing evidence' | 'Not recorded';

/** Failure categories, in the system's own terms where it has them. */
export const FAILURE_CATEGORIES = {
  productUnreachable: 'Product unreachable',
  invalidUrl: 'Invalid/broken URL',
  unsupportedProductType: 'Unsupported product type',
  preflightBlocked: 'Preflight blocked',
  deckUnavailable: 'Deck unavailable',
  demoUnavailable: 'Demo unavailable',
  promptInjection: 'Prompt injection detected',
  credentialGuard: 'Credential leak guard (fail-closed)',
  testPlanFailure: 'Test-plan generation failure',
  browserNavigation: 'Browser navigation failure',
  browserInteraction: 'Browser interaction failure',
  browserTimeout: 'Browser timeout',
  scoringFailure: 'Scoring failure',
  aiProvider: 'AI provider/API failure',
  internalWorker: 'Internal worker error',
  lowConfidence: 'Low confidence',
  manualReview: 'Manual review required',
  disqualified: 'Disqualified',
  incomplete: 'Incomplete assessment',
  noJob: 'No assessment job',
  unclassified: 'Unclassified recorded error',
  unknown: 'Unknown / reason not recorded',
} as const;

const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  preflight: 'Preflight',
  artifact_analysis: 'Artifact analysis',
  test_plan_generation: 'Test-plan generation',
  browser_testing: 'Browser testing',
  evidence_review: 'Evidence review',
  scoring: 'Scoring',
  consistency_review: 'Consistency review',
  completed: 'Completed',
  manual_review: 'Manual review',
  failed: 'Failed',
  disqualified: 'Disqualified',
};

/** `browser_testing` → "Browser testing"; an unknown value is humanised rather than dropped. */
export function describeStage(stage: string | null | undefined): string {
  if (!stage) return '';
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ');
}

const humanise = (code: string): string => code.replace(/_/g, ' ');
const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

// --------------------------------------------------------------------------
// Sanitisation
// --------------------------------------------------------------------------

/**
 * Patterns that must never survive into a file someone forwards.
 *
 * Error messages and flag details are written by code that already redacts,
 * but the audit export is the last line, so it redacts again. The list is
 * deliberately broad: a false positive costs a few characters of an error
 * message; a false negative is a password in a spreadsheet.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(password|passwd|pwd|passcode)\b([ \t]*[:=][ \t]*)\S+/gi, '$1$2[REDACTED]'],
  [/\b(bearer|token|api[_-]?key|apikey|secret|authorization|cookie|session[_-]?id)\b([ \t]*[:=][ \t]*)\S+/gi, '$1$2[REDACTED]'],
  [/([?&#](?:token|key|api_key|apikey|secret|password|pwd|auth|sig|signature|access_token|refresh_token|code)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"')]+/gi, '[REDACTED]'],
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@"']+:[^\s/@"']+@/g, '$1[REDACTED]@'],
];

const MAX_TECHNICAL_LENGTH = 600;

/** Free text from a system record, made safe to hand to a spreadsheet. */
export function sanitiseForExport(text: string | null | undefined): string {
  if (!text) return '';
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_TECHNICAL_LENGTH ? `${out.slice(0, MAX_TECHNICAL_LENGTH - 1)}…` : out;
}

// --------------------------------------------------------------------------
// Outcome and eligibility
// --------------------------------------------------------------------------

const PROCESSING_STAGES: ReadonlySet<string> = new Set(
  ASSESSMENT_HAPPY_PATH.filter((s) => s !== 'queued' && s !== 'completed'),
);

/**
 * The one bucket every submission belongs to.
 *
 * Taken from the job's own stage — the system's canonical state — with a
 * confirmed disqualification overriding it, because a disqualified product's
 * scores no longer describe an outcome anyone acts on.
 */
export function classifyOutcome(row: SubmissionAuditRow): AssessmentOutcome {
  if (row.disqualification?.status === 'confirmed' || row.job?.stage === 'disqualified') {
    return 'Disqualified';
  }
  if (!row.job) return 'Not assessed';
  switch (row.job.stage) {
    case 'completed':
      return 'Completed';
    case 'manual_review':
      return 'Needs human review';
    case 'failed':
      return 'Failed';
    case 'queued':
      return 'Queued';
    default:
      return PROCESSING_STAGES.has(row.job.stage) ? 'In progress' : 'In progress';
  }
}

export function hasCompleteScores(row: SubmissionAuditRow): boolean {
  return RUBRIC_CATEGORIES.every((c) => row.categoryScores[c.key] !== undefined);
}

/**
 * Rank eligibility, by the rule the ranking uses (`isEligibleForRanking`),
 * plus the one fact the rule cannot know: whether the current snapshot was
 * generated after this assessment finished.
 */
export function rankEligibility(row: SubmissionAuditRow): { eligible: boolean; exclusionReason: string } {
  const complete = hasCompleteScores(row);
  const eligible = isEligibleForRanking({
    submissionStatus: row.submissionStatus,
    hasConfirmedDisqualification: row.disqualification?.status === 'confirmed',
    hasCompleteScores: complete,
  });

  if (eligible) {
    if (row.ranking) return { eligible: true, exclusionReason: '' };
    return {
      eligible: true,
      exclusionReason: row.rankingGeneratedAt
        ? 'No current ranking entry — eligible, but the ranking was not regenerated after this assessment completed'
        : 'No current ranking entry — no ranking snapshot has been generated for this cohort',
    };
  }

  if (row.disqualification?.status === 'confirmed') return { eligible: false, exclusionReason: 'Confirmed disqualification' };
  if (!(SUBMISSION_FINAL_STATUSES as readonly string[]).includes(row.submissionStatus)) {
    return { eligible: false, exclusionReason: `Submission status "${row.submissionStatus}" is not a final submission` };
  }
  // From here the only remaining rule is the complete score set.
  if (!row.job) return { eligible: false, exclusionReason: 'No assessment job' };
  switch (row.job.stage) {
    case 'failed':
      return { eligible: false, exclusionReason: 'Assessment failed' };
    case 'manual_review':
      return { eligible: false, exclusionReason: 'Diverted to manual review before a complete score set was recorded' };
    case 'completed':
      return { eligible: false, exclusionReason: 'Missing complete category scores' };
    case 'disqualified':
      return { eligible: false, exclusionReason: 'Job marked disqualified' };
    default:
      return { eligible: false, exclusionReason: 'Assessment incomplete' };
  }
}

// --------------------------------------------------------------------------
// Failure stage
// --------------------------------------------------------------------------

/** Where a system-raised flag is raised from, by the pipeline's own structure. */
const FLAG_STAGE: Record<string, string> = {
  unsupported_product_type: 'preflight',
  product_unreachable: 'preflight',
  prompt_injection_detected: 'artifact_analysis',
  browser_never_reached_product: 'browser_testing',
  low_confidence_scores: 'scoring',
};

/** Messages the pipeline writes as `last_error`, and the stage that writes them. */
const ERROR_STAGE: readonly [RegExp, string][] = [
  [/^Preflight could not confirm the product is reachable\.?$/, 'preflight'],
  [/^The product could not be reached\.?$/, 'preflight'],
  [/^Product was unreachable; classified as a possible outage/, 'preflight'],
  [/^No valid test steps could be generated\.?$/, 'test_plan_generation'],
  [/^No product URL\.?$/, 'test_plan_generation'],
  [/^Missing product URL or test plan\.?$/, 'browser_testing'],
  [/^Scoring output was invalid/, 'scoring'],
  [/^Scoring produced an incomplete score set\.?$/, 'scoring'],
];

export interface FailureStageResult {
  stage: string;
  basis: FailureStageBasis;
  /** What the records show, in pipeline order — the reader's audit trail. */
  trail: string;
}

function latestSystemFlag(row: SubmissionAuditRow): AuditManualReviewFlag | null {
  const system = row.manualReviewFlags
    .filter((f) => f.raisedBy === 'system')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return system[0] ?? null;
}

function preflightFailed(row: SubmissionAuditRow): boolean {
  return Boolean(row.preflight?.checks.some((c) => c.status === 'fail'));
}

function browserNeverNavigated(row: SubmissionAuditRow): boolean {
  return row.browserRuns.length > 0 && !row.browserRuns.some((r) => r.navigationPassed);
}

function browserRunsAllBroken(row: SubmissionAuditRow): boolean {
  return row.browserRuns.length > 0 && row.browserRuns.every((r) => r.status === 'failed' || r.status === 'error');
}

/** The stage records in pipeline order, as one readable line. */
export function describeTrail(row: SubmissionAuditRow): string {
  const parts: string[] = [];
  if (row.preflight) {
    const failed = row.preflight.checks.filter((c) => c.status === 'fail').map((c) => c.checkKey);
    const warned = row.preflight.checks.filter((c) => c.status === 'warn').map((c) => c.checkKey);
    parts.push(
      `preflight attempt ${row.preflight.attempt}: ` +
        (failed.length ? `failed ${failed.join(', ')}` : 'passed') +
        (warned.length ? ` (warnings: ${warned.join(', ')})` : ''),
    );
  } else {
    parts.push('preflight: no record');
  }
  parts.push(
    row.artifactAnalysis
      ? `artifact analysis: saved${row.artifactAnalysis.injectionFlagCount ? ` (${row.artifactAnalysis.injectionFlagCount} injection flag(s))` : ''}`
      : 'artifact analysis: no record',
  );
  parts.push(
    row.testPlan
      ? `test plan: ${row.testPlan.stepCount} steps (${row.testPlan.validationStatus}${row.testPlan.rejectedStepCount ? `, ${row.testPlan.rejectedStepCount} rejected` : ''})`
      : 'test plan: no record',
  );
  if (row.browserRuns.length === 0) {
    parts.push('browser testing: no run recorded');
  } else {
    parts.push(
      'browser runs: ' +
        row.browserRuns
          .map(
            (r) =>
              `${r.viewport} attempt ${r.attempt} ${r.status}${r.timedOut ? ' (timed out)' : ''} ` +
              `${r.stepsPassed}/${r.stepsTotal} steps passed`,
          )
          .join('; '),
    );
  }
  parts.push(`evidence items: ${row.evidenceCount}`);
  const scored = Object.keys(row.categoryScores).length;
  parts.push(`scores: ${scored} of ${RUBRIC_CATEGORIES.length} categories`);
  return parts.join(' → ');
}

/**
 * The stage at which the assessment stopped.
 *
 * The job row records only that it failed, not where. An in-flight job names
 * its stage; a system flag or a canonical error message names the stage that
 * produced it; failing those, the furthest stage record that exists marks the
 * stage after it as the one that broke — and the row says so.
 */
export function deriveFailureStage(row: SubmissionAuditRow): FailureStageResult {
  const trail = describeTrail(row);
  if (!row.job) return { stage: '', basis: 'Not recorded', trail };

  if (PROCESSING_STAGES.has(row.job.stage) || row.job.stage === 'queued') {
    return { stage: row.job.stage, basis: 'Explicitly recorded', trail };
  }

  const flag = latestSystemFlag(row);
  if (row.job.stage === 'manual_review' && flag && FLAG_STAGE[flag.reasonCode]) {
    return { stage: FLAG_STAGE[flag.reasonCode]!, basis: 'Explicitly recorded', trail };
  }
  if (row.job.lastError) {
    for (const [pattern, stage] of ERROR_STAGE) {
      if (pattern.test(row.job.lastError.trim())) return { stage, basis: 'Explicitly recorded', trail };
    }
  }
  if (flag && FLAG_STAGE[flag.reasonCode]) {
    return { stage: FLAG_STAGE[flag.reasonCode]!, basis: 'Explicitly recorded', trail };
  }

  if (row.job.stage === 'completed' || row.job.stage === 'disqualified') {
    return { stage: '', basis: 'Not recorded', trail };
  }

  // Failed (or diverted without a recognisable reason): read the trail.
  const derived = (stage: string): FailureStageResult => ({ stage, basis: 'Derived from existing evidence', trail });
  const nothingRecorded =
    !row.preflight && !row.artifactAnalysis && !row.testPlan && row.browserRuns.length === 0 && row.evidenceCount === 0;
  if (nothingRecorded) {
    return Object.keys(row.categoryScores).length > 0 ? derived('scoring') : { stage: '', basis: 'Not recorded', trail };
  }
  if (!row.preflight || preflightFailed(row)) return derived('preflight');
  if (!row.artifactAnalysis) return derived('artifact_analysis');
  if (!row.testPlan || row.testPlan.validationStatus === 'rejected') return derived('test_plan_generation');
  if (row.browserRuns.length === 0 || browserNeverNavigated(row) || browserRunsAllBroken(row)) return derived('browser_testing');
  if (row.evidenceCount === 0) return derived('evidence_review');
  if (!hasCompleteScores(row) || !row.summary) return derived('scoring');
  return derived('consistency_review');
}

// --------------------------------------------------------------------------
// Failure reason
// --------------------------------------------------------------------------

export interface FailureExplanation {
  failureStage: string;
  failureStageBasis: FailureStageBasis;
  failureCategory: string;
  explanation: string;
  technicalDetail: string;
  reasonSource: ReasonSource;
  evidenceQuality: EvidenceQuality;
}

const NO_FAILURE: FailureExplanation = {
  failureStage: '',
  failureStageBasis: 'Not recorded',
  failureCategory: '',
  explanation: '',
  technicalDetail: '',
  reasonSource: 'Not recorded',
  evidenceQuality: 'Unknown',
};

function attempts(row: SubmissionAuditRow): string {
  return row.job ? `attempts ${row.job.attemptCount} of ${row.job.maxAttempts}` : '';
}

function unreachableWording(failureClass: FailureClass | null | undefined): string {
  switch (failureClass) {
    case 'timeout':
      return 'did not respond within the time limit';
    case 'dns':
      return "hostname could not be resolved";
    case 'auth':
      return 'answered with an access-denied response (a login wall or a restricted deployment)';
    case 'server':
      return 'returned a server error';
    case 'blocked':
      return 'was blocked by the egress policy';
    case 'invalid':
      return 'address was not a valid product URL';
    default:
      return 'could not be reached';
  }
}

function failedPreflightCheck(row: SubmissionAuditRow): AuditPreflightCheck | null {
  return row.preflight?.checks.find((c) => c.status === 'fail') ?? null;
}

function preflightCategory(check: AuditPreflightCheck): string {
  switch (check.checkKey) {
    case 'http_reachable':
    case 'dns_resolves':
      return FAILURE_CATEGORIES.productUnreachable;
    case 'url_valid':
    case 'unsafe_url':
    case 'https_enforced':
    case 'redirects_sane':
      return FAILURE_CATEGORIES.invalidUrl;
    case 'product_type_supported':
      return FAILURE_CATEGORIES.unsupportedProductType;
    case 'deck_readable':
      return FAILURE_CATEGORIES.deckUnavailable;
    case 'demo_link_accessible':
      return FAILURE_CATEGORIES.demoUnavailable;
    default:
      return FAILURE_CATEGORIES.preflightBlocked;
  }
}

/** A recorded error the pipeline or the platform is known to produce. */
function classifyRecordedError(
  error: string,
  row: SubmissionAuditRow,
  stageLabel: string,
): { category: string; explanation: string; detail: string; quality: EvidenceQuality } | null {
  const text = error.trim();
  const safe = sanitiseForExport(text);
  const where = stageLabel ? `${stageLabel.toLowerCase()}: ` : '';
  const withAttempts = `${where}${safe}${row.job ? `; ${attempts(row)}` : ''}`;

  const permission = /permission denied for (?:table|relation) "?([a-z_]+)"?/i.exec(text);
  if (permission) {
    const table = permission[1]!;
    const credentials = table === 'submission_credentials';
    return {
      category: FAILURE_CATEGORIES.internalWorker,
      explanation: credentials
        ? `The Judge reached ${stageLabel.toLowerCase() || 'the stage'} and needed the team's login details, but its worker was refused access to the credentials table by the database, so the product was never opened in the browser. This is a platform fault, not a finding about the product.`
        : `The Judge's worker was refused access to the database table "${table}" during ${stageLabel.toLowerCase() || 'the assessment'}, so the assessment stopped. This is a platform fault, not a finding about the product.`,
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/labelled password|Refusing to send an AI payload/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.credentialGuard,
      explanation: `The submission's written material still contained a labelled password after redaction, so the Judge refused to send that text to the AI model and stopped at ${stageLabel.toLowerCase() || 'that stage'}. This is the safety guard working as designed; the product itself was not tested.`,
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/lease expired/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.internalWorker,
      explanation: 'The worker holding this assessment stopped responding before the stage finished, and no later attempt completed it.',
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/^Submission not found/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.internalWorker,
      explanation: 'The worker could not load the submission it had been asked to assess.',
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/could not be reached|unreachable|could not confirm the product is reachable/i.test(text)) {
    const check = failedPreflightCheck(row);
    return {
      category: FAILURE_CATEGORIES.productUnreachable,
      explanation: `The product ${unreachableWording(check?.failureClass)} when the Judge checked it, so it was not judged on product behaviour.`,
      detail: check
        ? `${withAttempts}; preflight ${check.checkKey} failed (${check.failureClass})${check.message ? `: ${sanitiseForExport(check.message)}` : ''}`
        : withAttempts,
      quality: 'High',
    };
  }
  if (/^No valid test steps could be generated/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.testPlanFailure,
      explanation: 'The Judge could not turn the submission into any valid browser test step, so there was nothing to run against the product.',
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/^Scoring output was invalid|incomplete score set/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.scoringFailure,
      explanation: 'The scoring stage did not produce a valid, complete set of category scores, so the result was held for a human rather than ranked.',
      detail: withAttempts,
      quality: 'High',
    };
  }
  if (/^Missing product URL or test plan|^No product URL/i.test(text)) {
    return {
      category: FAILURE_CATEGORIES.invalidUrl,
      explanation: 'The assessment had no usable product URL (or no test plan) to run the browser against.',
      detail: withAttempts,
      quality: 'High',
    };
  }
  return null;
}

/** A best-effort class for a recorded error the pipeline does not name. */
function classifyUnknownError(
  error: string,
  row: SubmissionAuditRow,
  stage: string,
  stageLabel: string,
): { category: string; explanation: string; detail: string; quality: EvidenceQuality } {
  const safe = sanitiseForExport(error);
  const detail = `${stageLabel ? `${stageLabel.toLowerCase()}: ` : ''}${safe}${row.job ? `; ${attempts(row)}` : ''}`;
  if (stage === 'browser_testing' && /timed? ?out|timeout|exceeded/i.test(error)) {
    return {
      category: FAILURE_CATEGORIES.browserTimeout,
      explanation: 'Browser testing ran out of time before the recorded error, so the core workflow could not be completed.',
      detail,
      quality: 'Medium',
    };
  }
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ECONNRESET|page\.goto|navigation|Target closed|browser has disconnected/i.test(error)) {
    return {
      category: FAILURE_CATEGORIES.browserNavigation,
      explanation: 'The automated browser could not load or keep the product page open during testing.',
      detail,
      quality: 'Medium',
    };
  }
  if (/rate limit|429|quota|provider|openai|gemini|anthropic|model (?:call|request|response)|api key/i.test(error)) {
    return {
      category: FAILURE_CATEGORIES.aiProvider,
      explanation: 'A call to the AI provider failed during the assessment; the product itself was not judged on this attempt.',
      detail,
      quality: 'Medium',
    };
  }
  return {
    category: FAILURE_CATEGORIES.unclassified,
    explanation: `The assessment stopped with a recorded error that does not match a known failure class: ${safe}`,
    detail,
    quality: 'Medium',
  };
}

function explainFlag(
  flag: AuditManualReviewFlag,
  row: SubmissionAuditRow,
): { category: string; explanation: string; detail: string } {
  const detail = sanitiseForExport(flag.detail);
  switch (flag.reasonCode) {
    case 'product_unreachable': {
      const check = failedPreflightCheck(row);
      return {
        category: FAILURE_CATEGORIES.productUnreachable,
        explanation: `The product ${unreachableWording(check?.failureClass)} when the Judge checked it, so it was routed to a human and not judged on product behaviour.`,
        detail: check
          ? `preflight ${check.checkKey} failed (${check.failureClass}); flag: ${detail}`
          : `flag: ${detail}`,
      };
    }
    case 'unsupported_product_type':
      return {
        category: FAILURE_CATEGORIES.unsupportedProductType,
        explanation: 'The submitted link is not a running web application that the automated browser can test (for example a document or file-storage link), so it was routed to a human instead of being judged.',
        detail: `flag: ${detail}`,
      };
    case 'prompt_injection_detected':
      return {
        category: FAILURE_CATEGORIES.promptInjection,
        explanation: 'Instruction-like text aimed at an automated judge was found in the participant material; it was treated as data and the case was flagged for a human. This is not a scoring penalty.',
        detail: `flag: ${detail}`,
      };
    case 'browser_never_reached_product': {
      const failing = row.browserRuns.find((r) => r.firstFailure)?.firstFailure;
      return {
        category: FAILURE_CATEGORIES.browserNavigation,
        explanation: 'The automated browser never loaded the product page, so nothing it observed is evidence about the product; a human needs to look.',
        detail: `flag: ${detail}${failing ? `; first failing step ${failing.stepIndex} (${failing.action}): ${sanitiseForExport(failing.errorMessage)}` : ''}`,
      };
    }
    case 'low_confidence_scores':
      return {
        category: FAILURE_CATEGORIES.lowConfidence,
        explanation: 'The Judge completed the assessment, but at least one scoring category fell below the confidence threshold, so the result is provisional and needs a human look.',
        detail:
          `flag: ${detail}` +
          (row.summary ? `; minimum confidence ${row.summary.minConfidence.toFixed(2)}` : '') +
          (row.lowConfidenceThreshold !== null ? `; configured threshold ${row.lowConfidenceThreshold}` : ''),
      };
    default:
      return {
        category: humanise(flag.reasonCode),
        explanation: `The assessment was flagged for a human: ${detail || humanise(flag.reasonCode)}.`,
        detail: `flag ${flag.reasonCode}: ${detail}`,
      };
  }
}

/**
 * Why the product has no rank, from the strongest evidence available.
 *
 * Priority, per the audit's own rule: the job's explicit error when it names a
 * known cause; a system-raised manual-review flag; a preflight, browser-run or
 * test-plan record showing the failure point; an unclassified recorded error;
 * and only then "not recorded".
 */
export function explainOutcome(row: SubmissionAuditRow): FailureExplanation {
  const outcome = classifyOutcome(row);
  if (outcome === 'Completed') return NO_FAILURE;

  const stage = deriveFailureStage(row);
  const stageLabel = describeStage(stage.stage);
  const trailNote = stage.basis === 'Derived from existing evidence' ? ` Stage derived from records: ${stage.trail}.` : '';
  const base = { failureStage: stageLabel, failureStageBasis: stage.basis };

  if (outcome === 'Not assessed') {
    return {
      ...base,
      failureStage: 'Not started',
      failureStageBasis: 'Derived from existing evidence',
      failureCategory: FAILURE_CATEGORIES.noJob,
      explanation: 'The submission was imported but no assessment job exists for it, so judging never started.',
      technicalDetail: 'No assessment_jobs row for this submission.',
      reasonSource: 'Derived from existing evidence',
      evidenceQuality: 'Medium',
    };
  }

  if (outcome === 'Disqualified') {
    const dq = row.disqualification;
    return {
      ...base,
      failureStage: dq ? '' : stageLabel,
      failureCategory: FAILURE_CATEGORIES.disqualified,
      explanation: dq
        ? `The submission was disqualified (${humanise(dq.reasonCode)})${dq.reasonDetail ? `: ${sanitiseForExport(dq.reasonDetail)}` : '.'}`
        : 'The assessment job is marked disqualified but no disqualification record exists.',
      technicalDetail: dq ? `disqualification ${dq.status}: ${dq.reasonCode}` : `job stage ${row.job?.stage ?? ''}`,
      reasonSource: dq ? 'Disqualification record' : 'Assessment job record',
      evidenceQuality: dq ? 'High' : 'Low',
    };
  }

  if (outcome === 'Queued' || outcome === 'In progress') {
    return {
      ...base,
      failureCategory: FAILURE_CATEGORIES.incomplete,
      explanation:
        outcome === 'Queued'
          ? 'The assessment is queued and has not been picked up by a worker yet.'
          : `The assessment is still in progress at ${stageLabel.toLowerCase()}.`,
      technicalDetail: `${row.job?.stage ?? ''}; ${attempts(row)}${row.job?.lastError ? `; last error: ${sanitiseForExport(row.job.lastError)}` : ''}`,
      reasonSource: 'Assessment job record',
      evidenceQuality: 'High',
    };
  }

  // Failed or needs human review.
  const error = row.job?.lastError?.trim() ?? '';
  const flag = latestSystemFlag(row);

  if (error) {
    const known = classifyRecordedError(error, row, stageLabel);
    if (known) {
      const flagSuffix = flag && outcome === 'Needs human review' ? `; flag ${flag.reasonCode}: ${sanitiseForExport(flag.detail)}` : '';
      return {
        ...base,
        failureCategory: known.category,
        explanation: known.explanation + trailNote,
        technicalDetail: known.detail + flagSuffix,
        reasonSource: 'Explicit system error',
        evidenceQuality: known.quality,
      };
    }
  }

  if (flag) {
    const explained = explainFlag(flag, row);
    const usedPreflight = flag.reasonCode === 'product_unreachable' && failedPreflightCheck(row) !== null;
    return {
      ...base,
      failureCategory: explained.category,
      explanation: explained.explanation + trailNote,
      technicalDetail: `${explained.detail}${error ? `; job error: ${sanitiseForExport(error)}` : ''}${row.job ? `; ${attempts(row)}` : ''}`,
      reasonSource: usedPreflight ? 'Preflight record' : 'Manual review flag',
      evidenceQuality: 'High',
    };
  }

  const check = failedPreflightCheck(row);
  if (check && (stage.stage === 'preflight' || !stage.stage)) {
    return {
      ...base,
      failureStage: describeStage('preflight'),
      failureStageBasis: 'Explicitly recorded',
      failureCategory: preflightCategory(check),
      explanation: `Preflight check "${humanise(check.checkKey)}" failed${check.message ? `: ${sanitiseForExport(check.message)}` : ''}, so the assessment did not continue.`,
      technicalDetail: `preflight ${check.checkKey} failed (${check.failureClass}); ${attempts(row)}`,
      reasonSource: 'Preflight record',
      evidenceQuality: 'High',
    };
  }

  const brokenRun = row.browserRuns.find((r) => r.status === 'failed' || r.status === 'error' || r.timedOut);
  if (brokenRun && (stage.stage === 'browser_testing' || !stage.stage)) {
    const failing = brokenRun.firstFailure;
    const category = brokenRun.timedOut
      ? FAILURE_CATEGORIES.browserTimeout
      : brokenRun.navigationPassed
        ? FAILURE_CATEGORIES.browserInteraction
        : FAILURE_CATEGORIES.browserNavigation;
    return {
      ...base,
      failureStage: describeStage('browser_testing'),
      failureStageBasis: 'Explicitly recorded',
      failureCategory: category,
      explanation: brokenRun.timedOut
        ? 'The browser reached the product but testing ran out of time before the core workflow could be completed.'
        : brokenRun.navigationPassed
          ? 'The browser opened the product, but a test step failed during the workflow and the run did not complete.'
          : 'The automated browser could not load the product page during testing.',
      technicalDetail:
        `browser run ${brokenRun.viewport} attempt ${brokenRun.attempt}: ${brokenRun.status}${brokenRun.timedOut ? ' (timed out)' : ''}, ` +
        `${brokenRun.stepsPassed}/${brokenRun.stepsTotal} steps passed` +
        (failing ? `; first failing step ${failing.stepIndex} (${failing.action}): ${sanitiseForExport(failing.errorMessage)}` : '') +
        `; ${attempts(row)}`,
      reasonSource: 'Browser run record',
      evidenceQuality: 'High',
    };
  }

  if (row.testPlan && row.testPlan.validationStatus === 'rejected' && stage.stage === 'test_plan_generation') {
    return {
      ...base,
      failureCategory: FAILURE_CATEGORIES.testPlanFailure,
      explanation: 'The generated test plan was rejected in validation, so no browser test could run.',
      technicalDetail: `test plan rejected: ${row.testPlan.rejectedStepCount} step(s) rejected of ${row.testPlan.stepCount}; ${attempts(row)}`,
      reasonSource: 'Test plan record',
      evidenceQuality: 'High',
    };
  }

  if (error) {
    const guess = classifyUnknownError(error, row, stage.stage, stageLabel);
    return {
      ...base,
      failureCategory: guess.category,
      explanation: guess.explanation + trailNote,
      technicalDetail: guess.detail,
      reasonSource: 'Explicit system error',
      evidenceQuality: guess.quality,
    };
  }

  return {
    ...base,
    failureStage: stage.stage ? stageLabel : 'Unknown',
    failureCategory: FAILURE_CATEGORIES.unknown,
    explanation:
      'The assessment did not complete, but the system does not contain enough persisted information to determine the exact cause.',
    technicalDetail:
      `No canonical error, flag or sufficiently specific stage evidence was found. Records: ${stage.trail}` +
      (row.job ? `; ${attempts(row)}` : ''),
    reasonSource: 'Not recorded',
    evidenceQuality: 'Unknown',
  };
}

// --------------------------------------------------------------------------
// Manual review, confidence
// --------------------------------------------------------------------------

export function describeManualReview(row: SubmissionAuditRow): {
  flagged: boolean;
  status: string;
  reasons: string;
  resolved: string;
  lowConfidence: boolean;
} {
  const flags = [...row.manualReviewFlags].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (flags.length === 0) {
    return { flagged: false, status: '', reasons: '', resolved: '', lowConfidence: row.summary?.lowConfidence ?? false };
  }
  const open = flags.filter((f) => f.status === 'open');
  const status = open.length > 0 ? 'open' : (flags[flags.length - 1]!.status);
  const reasons = flags
    .map((f) => {
      const detail = sanitiseForExport(f.detail);
      const text = detail ? `${humanise(f.reasonCode)}: ${detail}` : humanise(f.reasonCode);
      return f.status === 'open' ? text : `${text} [${f.status}${f.resolutionNote ? `: ${sanitiseForExport(f.resolutionNote)}` : ''}]`;
    })
    .join(' | ');
  const lowConfidence = (row.summary?.lowConfidence ?? false) || open.some((f) => f.reasonCode === 'low_confidence_scores');
  return { flagged: true, status, reasons, resolved: yesNo(open.length === 0), lowConfidence };
}

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------

/** The columns, in order. Exported so a test can pin them. */
export const SUBMISSIONS_AUDIT_HEADERS: readonly string[] = [
  'Cohort',
  'Cohort Code',
  'Submission ID',
  'Group Number',
  'Product Name',
  'Idea / Category',
  'Idea Slug',
  'Submission Status',
  'Login Required',
  'Assessment Outcome',
  'Current / Final Stage',
  'Rank Eligible',
  'Rank Exclusion Reason',
  'Failure Stage',
  'Failure Stage Basis',
  'Failure Category',
  'Failure Explanation',
  'Technical Detail',
  'Reason Source',
  'Reason Evidence Quality',
  'Attempt Count',
  'Max Attempts',
  'Assessment Started',
  'Assessment Finished',
  'Manual Review',
  'Manual Review Status',
  'Manual Review Reason(s)',
  'Review Resolved',
  'Low Confidence',
  'Overall Confidence',
  'Lowest Category Confidence',
  'Confidence Threshold',
  'Disqualified',
  'Disqualification Status',
  'Disqualification Reason',
  'Rank',
  'Total Score',
  'Maximum Score',
  'In Shortlist',
  'Ranking Generated At',
  'Final Winner Position',
  'Final Selection Reason',
  ...RUBRIC_CATEGORIES.map((c) => RESULTS_EXPORT_CATEGORY_LABELS[c.key]),
  'Scored Categories',
  'Overridden Categories',
  'Preflight Result',
  'Artifact Analysis',
  'Test Plan',
  'Browser Runs',
  'Evidence Items',
  'Product URL',
  'Loom / Demo URL',
  'Deck URL',
  'Feedback Status',
  'Feedback Error / Failure Reason',
  'Feedback Summary',
  'Feedback Strength 1',
  'Feedback Strength 2',
  'Feedback Strength 3',
  'Feedback Improvement 1',
  'Feedback Improvement 2',
  'Feedback Improvement 3',
  'Feedback Bugs / Issues',
  'Feedback 7-Day Plan',
];

const iso = (value: Date | null | undefined): string => (value ? value.toISOString() : '');
const fixed = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? '' : value.toFixed(2);

function describeFeedbackStatus(row: SubmissionAuditRow): string {
  if (row.feedback) return 'ready';
  if (classifyOutcome(row) !== 'Completed' && row.feedbackStatus === 'pending') return 'not applicable';
  return row.feedbackStatus === 'generated' ? 'pending' : row.feedbackStatus;
}

function improvementCells(report: FeedbackReport | null): [string, string, string] {
  if (!report) return ['', '', ''];
  const ordered = [...report.improvements].sort((a, b) => a.priority - b.priority);
  const cell = (index: number) => {
    const item = ordered[index];
    if (!item) return '';
    return item.detail ? `${item.title}: ${item.detail}` : item.title;
  };
  return [cell(0), cell(1), cell(2)];
}

function preflightCell(row: SubmissionAuditRow): string {
  if (!row.preflight) return '';
  const failed = row.preflight.checks.filter((c) => c.status === 'fail');
  const warned = row.preflight.checks.filter((c) => c.status === 'warn');
  if (failed.length === 0 && warned.length === 0) return `passed (attempt ${row.preflight.attempt})`;
  const part = (c: AuditPreflightCheck) =>
    `${c.checkKey} ${c.status}${c.failureClass !== 'none' ? ` (${c.failureClass})` : ''}${c.message ? `: ${sanitiseForExport(c.message)}` : ''}`;
  return `attempt ${row.preflight.attempt}: ${[...failed, ...warned].map(part).join(' | ')}`;
}

function artifactCell(row: SubmissionAuditRow): string {
  const a = row.artifactAnalysis;
  if (!a) return '';
  const parts = [
    a.deckPageCount !== null ? `deck ${a.deckPageCount} page(s)${a.deckTextExtracted ? ', text extracted' : ', no text extracted'}` : 'no deck analysed',
    a.videoAnalysisLimited ? `video analysis limited${a.videoLimitationReason ? ` (${sanitiseForExport(a.videoLimitationReason)})` : ''}` : 'video analysed',
  ];
  if (a.injectionFlagCount > 0) parts.push(`${a.injectionFlagCount} injection flag(s)`);
  return parts.join('; ');
}

function browserRunsCell(row: SubmissionAuditRow): string {
  return row.browserRuns
    .map(
      (r) =>
        `${r.viewport} attempt ${r.attempt}: ${r.status}${r.timedOut ? ' (timed out)' : ''}, ${r.stepsPassed}/${r.stepsTotal} steps passed` +
        (r.firstFailure ? `, first failure at step ${r.firstFailure.stepIndex} (${r.firstFailure.action})` : ''),
    )
    .join(' | ');
}

/** One CSV row, in `SUBMISSIONS_AUDIT_HEADERS` order. */
export function submissionAuditRow(row: SubmissionAuditRow): unknown[] {
  const outcome = classifyOutcome(row);
  const eligibility = rankEligibility(row);
  const failure = explainOutcome(row);
  const review = describeManualReview(row);
  const dq = row.disqualification;
  const scored = RUBRIC_CATEGORIES.filter((c) => row.categoryScores[c.key] !== undefined);
  const overridden = scored.filter((c) => row.categoryScores[c.key]?.isOverridden).map((c) => RESULTS_EXPORT_CATEGORY_LABELS[c.key]);
  const [i1, i2, i3] = improvementCells(row.feedback);
  const complete = hasCompleteScores(row);
  const totalScore = row.ranking ? row.ranking.totalScore : complete && row.summary ? row.summary.totalScore : null;
  const overallConfidence = row.ranking ? row.ranking.meanConfidence : row.summary ? row.summary.meanConfidence : null;

  return [
    row.cohortName,
    row.cohortCode,
    row.submissionId,
    row.groupNumber,
    row.productName ?? '',
    row.ideaTitle ?? '',
    row.ideaSlug ?? '',
    row.submissionStatus,
    yesNo(row.loginRequired),
    outcome,
    describeStage(row.job?.stage),
    yesNo(eligibility.eligible),
    eligibility.exclusionReason,
    failure.failureStage,
    failure.failureStage ? failure.failureStageBasis : '',
    failure.failureCategory,
    failure.explanation,
    failure.technicalDetail,
    failure.failureCategory ? failure.reasonSource : '',
    failure.failureCategory ? failure.evidenceQuality : '',
    row.job ? row.job.attemptCount : '',
    row.job ? row.job.maxAttempts : '',
    iso(row.job?.startedAt),
    iso(row.job?.completedAt),
    yesNo(review.flagged),
    review.status,
    review.reasons,
    review.resolved,
    yesNo(review.lowConfidence),
    fixed(overallConfidence),
    fixed(row.summary?.minConfidence),
    row.lowConfidenceThreshold ?? '',
    yesNo(dq?.status === 'confirmed'),
    dq?.status ?? '',
    dq ? `${humanise(dq.reasonCode)}${dq.reasonDetail ? `: ${sanitiseForExport(dq.reasonDetail)}` : ''}` : '',
    row.ranking?.rank ?? '',
    fixed(totalScore),
    RESULTS_EXPORT_MAX_SCORE,
    row.ranking ? yesNo(row.ranking.inShortlist) : '',
    iso(row.rankingGeneratedAt),
    row.finalPosition ?? '',
    row.finalSelectionReason ?? '',
    ...RUBRIC_CATEGORIES.map((c) => {
      const score = row.categoryScores[c.key];
      return score ? score.rawScore.toFixed(2) : '';
    }),
    `${scored.length} of ${RUBRIC_CATEGORIES.length}`,
    overridden.join('; '),
    preflightCell(row),
    artifactCell(row),
    row.testPlan ? `${row.testPlan.stepCount} steps (${row.testPlan.validationStatus}${row.testPlan.rejectedStepCount ? `, ${row.testPlan.rejectedStepCount} rejected` : ''})` : '',
    browserRunsCell(row),
    row.job ? row.evidenceCount : '',
    // Participant-typed links: a URL with embedded `user:password@` is a secret.
    sanitiseForExport(row.productUrl),
    sanitiseForExport(row.loomUrl),
    sanitiseForExport(row.deckUrl),
    describeFeedbackStatus(row),
    row.feedback ? '' : sanitiseForExport(row.feedbackError),
    row.feedback?.productSummary ?? '',
    row.feedback?.strengths[0] ?? '',
    row.feedback?.strengths[1] ?? '',
    row.feedback?.strengths[2] ?? '',
    i1,
    i2,
    i3,
    row.feedback
      ? row.feedback.bugs.map((bug) => (bug.evidence ? `${bug.description} (evidence: ${bug.evidence})` : bug.description)).join('\n')
      : '',
    row.feedback ? row.feedback.nextSevenDayPlan.map((step, index) => `${index + 1}. ${step}`).join('\n') : '',
  ];
}

/** Ranked first by rank, then everything else by group number. */
export function orderAuditRows(rows: readonly SubmissionAuditRow[]): SubmissionAuditRow[] {
  return [...rows].sort((a, b) => {
    if (a.ranking && b.ranking) return a.ranking.rank - b.ranking.rank;
    if (a.ranking) return -1;
    if (b.ranking) return 1;
    return a.groupNumber - b.groupNumber || a.submissionId.localeCompare(b.submissionId);
  });
}

/**
 * The whole file: a UTF-8 byte-order mark, then RFC 4180 rows from `toCsv`,
 * whose leading-quote guard stops a cell beginning with `=`, `+`, `-`, `@`,
 * tab or CR from executing as a formula when the file is opened.
 */
export function buildSubmissionsAuditCsv(rows: readonly SubmissionAuditRow[]): string {
  return `\uFEFF${toCsv([...SUBMISSIONS_AUDIT_HEADERS], orderAuditRows(rows).map(submissionAuditRow))}`;
}

/** `aiap-c14-all-submissions-audit-2026-09-27T09-30-00Z.csv` */
export function submissionsAuditFilename(cohortCode: string, at: Date = new Date()): string {
  const code = cohortCode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cohort';
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${code}-all-submissions-audit-${stamp}.csv`;
}

// --------------------------------------------------------------------------
// Team results sheet
// --------------------------------------------------------------------------

/**
 * The columns of the team-share sheet: the same facts as the audit export,
 * ordered for someone who is not an engineer — outcome and rank first,
 * scores, links and feedback next, technical fields last.
 */
export const TEAM_RESULTS_HEADERS: readonly string[] = [
  'Group Number',
  'Product Name',
  'Idea / Category',
  'Ranking Status',
  'Rank',
  'Total Score',
  'In Top 10',
  'Assessment Outcome',
  'Why Not Ranked / Review Reason',
  'Failure Stage',
  'Failure Category',
  'Manual Review',
  'Low Confidence',
  'Feedback Status',
  ...RUBRIC_CATEGORIES.map((c) => RESULTS_EXPORT_CATEGORY_LABELS[c.key]),
  'Product URL',
  'Loom / Demo URL',
  'Deck URL',
  'Feedback Summary',
  'Strength 1',
  'Strength 2',
  'Strength 3',
  'Improvement 1',
  'Improvement 2',
  'Improvement 3',
  'Bugs / Issues',
  '7-Day Plan',
  'Submission ID',
  'Attempt Count',
  'Reason Source',
  'Reason Evidence Quality',
  'Technical Detail',
];

/** "Ranked", or "Not Ranked — <why>" in the words the outcome bucket uses. */
export function describeRankingStatus(row: SubmissionAuditRow): string {
  if (row.ranking) return 'Ranked';
  switch (classifyOutcome(row)) {
    case 'Failed':
      return 'Not Ranked — Assessment Failed';
    case 'Needs human review':
      return 'Not Ranked — Needs Human Review';
    case 'Disqualified':
      return 'Not Ranked — Disqualified';
    default:
      return 'Not Ranked — Incomplete';
  }
}

/** One row of the team sheet, in `TEAM_RESULTS_HEADERS` order. */
export function teamResultsRow(row: SubmissionAuditRow): unknown[] {
  const outcome = classifyOutcome(row);
  const failure = explainOutcome(row);
  const review = describeManualReview(row);
  const eligibility = rankEligibility(row);
  const complete = hasCompleteScores(row);
  const totalScore = row.ranking ? row.ranking.totalScore : complete && row.summary ? row.summary.totalScore : null;
  const why = row.ranking
    ? review.status === 'open'
      ? review.reasons
      : ''
    : failure.explanation || eligibility.exclusionReason;
  const [i1, i2, i3] = improvementCells(row.feedback);

  return [
    row.groupNumber,
    row.productName ?? '',
    row.ideaTitle ?? '',
    describeRankingStatus(row),
    row.ranking?.rank ?? '',
    fixed(totalScore),
    row.ranking ? yesNo(row.ranking.inShortlist) : '',
    outcome,
    why,
    failure.failureStage,
    failure.failureCategory,
    yesNo(review.flagged),
    yesNo(review.lowConfidence),
    describeFeedbackStatus(row),
    ...RUBRIC_CATEGORIES.map((c) => {
      const score = row.categoryScores[c.key];
      return score ? score.rawScore.toFixed(2) : '';
    }),
    sanitiseForExport(row.productUrl),
    sanitiseForExport(row.loomUrl),
    sanitiseForExport(row.deckUrl),
    row.feedback?.productSummary ?? '',
    row.feedback?.strengths[0] ?? '',
    row.feedback?.strengths[1] ?? '',
    row.feedback?.strengths[2] ?? '',
    i1,
    i2,
    i3,
    row.feedback
      ? row.feedback.bugs.map((bug) => (bug.evidence ? `${bug.description} (evidence: ${bug.evidence})` : bug.description)).join('\n')
      : '',
    row.feedback ? row.feedback.nextSevenDayPlan.map((step, index) => `${index + 1}. ${step}`).join('\n') : '',
    row.submissionId,
    row.job ? row.job.attemptCount : '',
    failure.failureCategory ? failure.reasonSource : '',
    failure.failureCategory ? failure.evidenceQuality : '',
    failure.technicalDetail,
  ];
}

/** The team sheet: ranked rows first by rank, then the rest by group number. Same safety as the audit file. */
export function buildTeamResultsCsv(rows: readonly SubmissionAuditRow[]): string {
  return `﻿${toCsv([...TEAM_RESULTS_HEADERS], orderAuditRows(rows).map(teamResultsRow))}`;
}

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------

export interface SubmissionAuditSummary {
  total: number;
  ranked: number;
  /** Completed with a full score set but absent from the current snapshot. */
  completedUnranked: number;
  needsHumanReview: number;
  failed: number;
  disqualified: number;
  /** Queued or mid-pipeline. */
  incomplete: number;
  notAssessed: number;
  /** Ranked products carrying at least one open manual-review flag. */
  rankedWithOpenFlags: number;
}

/** Counts an operator wants beside the export button; every row lands in exactly one bucket. */
export function summariseSubmissionAudit(rows: readonly SubmissionAuditRow[]): SubmissionAuditSummary {
  const summary: SubmissionAuditSummary = {
    total: rows.length,
    ranked: 0,
    completedUnranked: 0,
    needsHumanReview: 0,
    failed: 0,
    disqualified: 0,
    incomplete: 0,
    notAssessed: 0,
    rankedWithOpenFlags: 0,
  };
  for (const row of rows) {
    const outcome = classifyOutcome(row);
    if (outcome === 'Completed') {
      if (row.ranking) {
        summary.ranked += 1;
        if (row.manualReviewFlags.some((f) => f.status === 'open')) summary.rankedWithOpenFlags += 1;
      } else {
        summary.completedUnranked += 1;
      }
    } else if (outcome === 'Needs human review') summary.needsHumanReview += 1;
    else if (outcome === 'Failed') summary.failed += 1;
    else if (outcome === 'Disqualified') summary.disqualified += 1;
    else if (outcome === 'Not assessed') summary.notAssessed += 1;
    else summary.incomplete += 1;
  }
  return summary;
}
