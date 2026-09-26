/**
 * The results-and-feedback export.
 *
 * One row per entry of the current ranking snapshot — all of them, not the
 * shortlist — with the eight category scores, the winner position if a person
 * recorded one, the review and disqualification state, the supporting links,
 * and the participant feedback report flattened into columns a spreadsheet can
 * hold.
 *
 * Two rules matter more than the column list.
 *
 * NOTHING IS DROPPED. A ranked product whose feedback report is pending or
 * failed is still a row; its feedback columns are empty and `Feedback Status`
 * says why. An export that quietly omitted three of eighty products would be
 * read as a complete list by whoever received it.
 *
 * NOTHING SECRET. This module never sees a credential, a ciphertext, a storage
 * path, a prompt or a token — `RankedResultRow` has nowhere to put one, so the
 * export cannot leak what it was never given. Learner contact details are
 * equally absent: a judging export is about products, not people.
 *
 * Cells that a learner typed (product name, URLs, feedback text derived from
 * their product) go through `escapeCsvCell`, whose leading-quote guard stops a
 * cell beginning with `=`, `+`, `-`, `@`, tab or CR from executing as a formula
 * when the file is opened in Excel or Sheets.
 */

import { RUBRIC_CATEGORIES, type RubricCategoryKey } from '../rubric/index';
import type { FeedbackReport, FeedbackStatus } from '../data/types';
import { toCsv } from '../utils/csv';

export interface RankedResultCategoryScore {
  /** The effective score — the human override where one exists (ADR-012). */
  rawScore: number;
  maxPoints: number;
  confidence: number;
  isOverridden: boolean;
}

/** Everything the export needs about one ranked product, and nothing secret. */
export interface RankedResultRow {
  cohortId: string;
  cohortName: string;
  cohortCode: string;

  submissionId: string;
  groupNumber: number;
  productName: string | null;
  ideaTitle: string | null;
  ideaSlug: string | null;

  rank: number;
  totalScore: number;
  inShortlist: boolean;
  meanConfidence: number;
  lowConfidence: boolean;

  /** 1 = 1st place, … — set only by a person on the Finalists page. */
  finalPosition: number | null;
  finalSelectionReason: string | null;

  assessmentStage: string | null;
  submissionStatus: string;

  /** Reason codes of open manual-review flags. */
  openManualReviewReasons: string[];
  disqualification: {
    status: 'proposed' | 'confirmed' | 'reversed';
    reasonCode: string;
    reasonDetail: string;
  } | null;

  productUrl: string | null;
  loomUrl: string | null;
  deckUrl: string | null;
  /** True when a PDF deck was uploaded through the older participant path. */
  hasUploadedDeck: boolean;

  categoryScores: Partial<Record<RubricCategoryKey, RankedResultCategoryScore>>;

  feedbackStatus: FeedbackStatus;
  feedbackError: string | null;
  feedbackAttempts: number;
  feedback: FeedbackReport | null;
}

export const RESULTS_EXPORT_SCOPES = ['all', 'shortlist', 'top'] as const;
export type ResultsExportScope = (typeof RESULTS_EXPORT_SCOPES)[number];

/** A ceiling on "Top N", so a typo cannot ask for a million rows. */
export const MAX_RESULTS_EXPORT_TOP_N = 1000;

export function isResultsExportScope(value: unknown): value is ResultsExportScope {
  return typeof value === 'string' && (RESULTS_EXPORT_SCOPES as readonly string[]).includes(value);
}

/**
 * Which ranked rows an export covers.
 *
 * `all` is the default and the reason this export exists. `shortlist` mirrors
 * the private top list. `top` takes the first N by rank, bounded, for a
 * "send feedback to the top 80" that is not a shortlist of 80.
 */
export function selectResultsForExport(
  rows: readonly RankedResultRow[],
  scope: ResultsExportScope,
  topN?: number,
): RankedResultRow[] {
  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  switch (scope) {
    case 'all':
      return ordered;
    case 'shortlist':
      return ordered.filter((row) => row.inShortlist);
    case 'top': {
      const n = Number(topN);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('Top N must be a whole number of at least 1.');
      }
      return ordered.slice(0, Math.min(n, MAX_RESULTS_EXPORT_TOP_N));
    }
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unknown export scope: ${String(exhaustive)}`);
    }
  }
}

/**
 * Column titles for the eight categories, as the programme team names them.
 *
 * Keyed by rubric key so a category added to the rubric without a column here
 * is a compile error, not a silently missing column.
 */
export const RESULTS_EXPORT_CATEGORY_LABELS: Record<RubricCategoryKey, string> = {
  problem_clarity: 'Problem Clarity',
  solution_usefulness: 'Solution Usefulness',
  core_workflow: 'Core Workflow',
  ease_of_use: 'Ease of Use',
  ai_usefulness: 'AI Usefulness',
  two_day_execution: 'Two-Day Execution',
  deck_demo: 'Deck & Demo',
  practical_potential: 'Practical Potential',
};

/** Total across the rubric; the rubric module guarantees it is 100. */
export const RESULTS_EXPORT_MAX_SCORE = RUBRIC_CATEGORIES.reduce((sum, c) => sum + c.maxPoints, 0);

function categoryHeader(key: RubricCategoryKey): string {
  const category = RUBRIC_CATEGORIES.find((c) => c.key === key);
  return `${RESULTS_EXPORT_CATEGORY_LABELS[key]} (max ${category?.maxPoints ?? '?'})`;
}

/** The columns, in order. Exported so a test can pin them. */
export const RESULTS_EXPORT_HEADERS: readonly string[] = [
  'Cohort',
  'Cohort Code',
  'Group Number',
  'Product Name',
  'Idea / Category',
  'Idea Slug',
  'Rank',
  'Total Score',
  'Maximum Score',
  'In Shortlist',
  'Final Winner Position',
  'Final Selection Reason',
  ...RUBRIC_CATEGORIES.map((c) => categoryHeader(c.key)),
  'Overridden Categories',
  'Assessment Status',
  'Overall Confidence',
  'Low Confidence',
  'Manual Review Flag',
  'Manual Review Reasons',
  'Disqualified',
  'Disqualification Status',
  'Disqualification Reason',
  'Product URL',
  'Loom / Demo URL',
  'Deck URL',
  'Uploaded Deck',
  'Feedback Status',
  'Feedback Error',
  'Feedback Summary',
  'Feedback Strength 1',
  'Feedback Strength 2',
  'Feedback Strength 3',
  'Feedback Improvement 1',
  'Feedback Improvement 2',
  'Feedback Improvement 3',
  'Feedback Bugs / Issues',
  'Feedback 7-Day Plan',
  'Submission ID',
];

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** A reason code as an operator reads it: `browser_never_reached_product` → words. */
const humanise = (code: string): string => code.replace(/_/g, ' ');

/**
 * Improvements in priority order, each as one readable cell.
 *
 * The report stores `{ title, detail, priority }`; a spreadsheet cell holds
 * "Title: detail". Sorted by priority so column 1 is the most important, which
 * is what "Improvement 1" implies.
 */
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

function strengthCells(report: FeedbackReport | null): [string, string, string] {
  if (!report) return ['', '', ''];
  return [report.strengths[0] ?? '', report.strengths[1] ?? '', report.strengths[2] ?? ''];
}

/** Bugs joined with line breaks inside one quoted cell. */
function bugsCell(report: FeedbackReport | null): string {
  if (!report) return '';
  return report.bugs
    .map((bug) => (bug.evidence ? `${bug.description} (evidence: ${bug.evidence})` : bug.description))
    .join('\n');
}

/** The plan as a numbered list inside one quoted cell. */
function planCell(report: FeedbackReport | null): string {
  if (!report) return '';
  return report.nextSevenDayPlan.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

/**
 * How a row's feedback reads to whoever opens the file.
 *
 * A report on disk is `ready` whatever the status column says. Without one,
 * the job's own status is the truth: `pending` (not yet attempted, or retry
 * requested), `generating` (in flight) or `failed` (attempts exhausted).
 */
export function describeFeedbackStatus(row: Pick<RankedResultRow, 'feedback' | 'feedbackStatus'>): string {
  if (row.feedback) return 'ready';
  return row.feedbackStatus === 'generated' ? 'pending' : row.feedbackStatus;
}

/** One CSV row, in `RESULTS_EXPORT_HEADERS` order. */
export function resultsExportRow(row: RankedResultRow): unknown[] {
  const overridden = RUBRIC_CATEGORIES.filter((c) => row.categoryScores[c.key]?.isOverridden).map(
    (c) => RESULTS_EXPORT_CATEGORY_LABELS[c.key],
  );
  const dq = row.disqualification;
  const [s1, s2, s3] = strengthCells(row.feedback);
  const [i1, i2, i3] = improvementCells(row.feedback);

  return [
    row.cohortName,
    row.cohortCode,
    row.groupNumber,
    row.productName ?? '',
    row.ideaTitle ?? '',
    row.ideaSlug ?? '',
    row.rank,
    row.totalScore.toFixed(2),
    RESULTS_EXPORT_MAX_SCORE,
    yesNo(row.inShortlist),
    row.finalPosition ?? '',
    row.finalSelectionReason ?? '',
    ...RUBRIC_CATEGORIES.map((c) => {
      const score = row.categoryScores[c.key];
      return score ? score.rawScore.toFixed(2) : '';
    }),
    overridden.join('; '),
    row.assessmentStage ?? '',
    row.meanConfidence.toFixed(2),
    yesNo(row.lowConfidence),
    yesNo(row.openManualReviewReasons.length > 0),
    row.openManualReviewReasons.map(humanise).join('; '),
    yesNo(dq?.status === 'confirmed'),
    dq?.status ?? '',
    dq ? `${humanise(dq.reasonCode)}${dq.reasonDetail ? `: ${dq.reasonDetail}` : ''}` : '',
    row.productUrl ?? '',
    row.loomUrl ?? '',
    row.deckUrl ?? '',
    yesNo(row.hasUploadedDeck),
    describeFeedbackStatus(row),
    row.feedback ? '' : (row.feedbackError ?? ''),
    row.feedback?.productSummary ?? '',
    s1,
    s2,
    s3,
    i1,
    i2,
    i3,
    bugsCell(row.feedback),
    planCell(row.feedback),
    row.submissionId,
  ];
}

/**
 * The whole file.
 *
 * Prefixed with a UTF-8 byte-order mark so Excel opens emoji and non-Latin
 * feedback text correctly on every platform; Sheets and every parser ignore it
 * (`parseCsv` strips it). RFC 4180 quoting and the formula guard come from
 * `toCsv`, the same code the access-code sheet uses.
 */
export function buildResultsFeedbackCsv(rows: readonly RankedResultRow[]): string {
  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  return `\uFEFF${toCsv([...RESULTS_EXPORT_HEADERS], ordered.map(resultsExportRow))}`;
}

/** `aiap-c14-results-feedback-2026-09-27T04-30-00Z.csv` — safe on every filesystem. */
export function resultsExportFilename(cohortCode: string, at: Date = new Date()): string {
  const code = cohortCode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cohort';
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${code}-results-feedback-${stamp}.csv`;
}

/** Counts an operator wants to see next to the export button. */
export function summariseFeedbackForExport(rows: readonly RankedResultRow[]): {
  ranked: number;
  ready: number;
  pending: number;
  generating: number;
  failed: number;
} {
  const summary = { ranked: rows.length, ready: 0, pending: 0, generating: 0, failed: 0 };
  for (const row of rows) {
    const status = describeFeedbackStatus(row);
    if (status === 'ready') summary.ready += 1;
    else if (status === 'generating') summary.generating += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.pending += 1;
  }
  return summary;
}
