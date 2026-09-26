import { describe, expect, it } from 'vitest';
import {
  RESULTS_EXPORT_CATEGORY_LABELS,
  RESULTS_EXPORT_HEADERS,
  RESULTS_EXPORT_MAX_SCORE,
  buildResultsFeedbackCsv,
  describeFeedbackStatus,
  resultsExportFilename,
  selectResultsForExport,
  summariseFeedbackForExport,
  type RankedResultRow,
} from './results-export';
import { parseCsv } from '../utils/csv';
import { RUBRIC_CATEGORIES } from '../rubric/index';
import type { FeedbackReport } from '../data/types';

/**
 * The results-and-feedback CSV, from rows to bytes.
 *
 * What these protect: no ranked product is dropped for lacking feedback, every
 * category has its own column, user-typed text cannot execute as a formula,
 * and the file round-trips through the project's own RFC 4180 parser with
 * commas, quotes, line breaks and emoji intact.
 */

const report = (over: Partial<FeedbackReport> = {}): FeedbackReport => ({
  id: 'fb-1',
  submissionId: 'sub-1',
  productSummary: 'A tidy habit tracker.',
  strengths: ['Fast to log', 'Clear dashboard', 'Persists on reload'],
  improvements: [
    { title: 'Edit entries', detail: 'Logged entries cannot be corrected.', priority: 2 },
    { title: 'Empty state', detail: 'The dashboard is blank before the first log.', priority: 1 },
    { title: 'Mobile layout', detail: 'The log button is off-screen at 390px.', priority: 3 },
  ],
  bugs: [
    { description: 'Water intake saves as 0', evidence: 'step 4 screenshot' },
    { description: 'Console error on load', evidence: 'console' },
  ],
  nextSevenDayPlan: ['Add edit', 'Fix water field', 'Ship mobile layout'],
  isExposedToParticipant: false,
  generatedAt: new Date('2026-09-26T10:00:00Z'),
  modelVersion: 'm',
  promptVersion: 'p',
  ...over,
});

const row = (over: Partial<RankedResultRow> = {}): RankedResultRow => ({
  cohortId: 'c14',
  cohortName: 'AIAP C14 Final',
  cohortCode: 'AIAP-C14',
  submissionId: 'sub-1',
  groupNumber: 12,
  productName: 'HabitHero',
  ideaTitle: 'Personal Health Manager',
  ideaSlug: 'personal-health-manager',
  rank: 1,
  totalScore: 81.25,
  inShortlist: true,
  meanConfidence: 0.83,
  lowConfidence: false,
  finalPosition: null,
  finalSelectionReason: null,
  assessmentStage: 'completed',
  submissionStatus: 'submitted',
  openManualReviewReasons: [],
  disqualification: null,
  productUrl: 'https://habithero.example.com',
  loomUrl: 'https://www.loom.com/share/abc',
  deckUrl: 'https://docs.google.com/presentation/d/x',
  hasUploadedDeck: false,
  categoryScores: Object.fromEntries(
    RUBRIC_CATEGORIES.map((c) => [
      c.key,
      { rawScore: c.maxPoints * 0.8, maxPoints: c.maxPoints, confidence: 0.8, isOverridden: false },
    ]),
  ),
  feedbackStatus: 'generated',
  feedbackError: null,
  feedbackAttempts: 1,
  feedback: report(),
  ...over,
});

/** Parse the file back through the project's own parser, BOM and all. */
function table(csv: string): Record<string, string>[] {
  const [headers, ...rows] = parseCsv(csv);
  return rows.map((cells) => Object.fromEntries(headers!.map((h, i) => [h, cells[i] ?? ''])));
}

describe('scope selection', () => {
  const rows = [row({ rank: 3, inShortlist: false }), row({ rank: 1 }), row({ rank: 2 })];

  it('exports every ranked entry by default, in rank order', () => {
    expect(selectResultsForExport(rows, 'all').map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('can narrow to the shortlist', () => {
    expect(selectResultsForExport(rows, 'shortlist').map((r) => r.rank)).toEqual([1, 2]);
  });

  it('can take the top N, bounded', () => {
    expect(selectResultsForExport(rows, 'top', 2).map((r) => r.rank)).toEqual([1, 2]);
    expect(selectResultsForExport(rows, 'top', 80).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(() => selectResultsForExport(rows, 'top', 0)).toThrow(/at least 1/);
    expect(() => selectResultsForExport(rows, 'top')).toThrow(/at least 1/);
  });
});

describe('the file', () => {
  it('has one column per rubric category and the required columns', () => {
    for (const category of RUBRIC_CATEGORIES) {
      expect(RESULTS_EXPORT_HEADERS).toContain(
        `${RESULTS_EXPORT_CATEGORY_LABELS[category.key]} (max ${category.maxPoints})`,
      );
    }
    for (const required of [
      'Cohort',
      'Group Number',
      'Product Name',
      'Idea / Category',
      'Rank',
      'Total Score',
      'Maximum Score',
      'In Shortlist',
      'Final Winner Position',
      'Assessment Status',
      'Overall Confidence',
      'Manual Review Flag',
      'Manual Review Reasons',
      'Disqualified',
      'Disqualification Reason',
      'Product URL',
      'Loom / Demo URL',
      'Deck URL',
      'Feedback Status',
      'Feedback Summary',
      'Feedback Strength 1',
      'Feedback Strength 2',
      'Feedback Strength 3',
      'Feedback Improvement 1',
      'Feedback Improvement 2',
      'Feedback Improvement 3',
      'Feedback Bugs / Issues',
      'Feedback 7-Day Plan',
    ]) {
      expect(RESULTS_EXPORT_HEADERS).toContain(required);
    }
    expect(RESULTS_EXPORT_MAX_SCORE).toBe(100);
  });

  it('writes the category scores in the rubric order the header promises', () => {
    const csv = buildResultsFeedbackCsv([row()]);
    const [record] = table(csv);
    for (const category of RUBRIC_CATEGORIES) {
      expect(record![`${RESULTS_EXPORT_CATEGORY_LABELS[category.key]} (max ${category.maxPoints})`]).toBe(
        (category.maxPoints * 0.8).toFixed(2),
      );
    }
    expect(record!['Total Score']).toBe('81.25');
    expect(record!['Maximum Score']).toBe('100');
    expect(record!['Rank']).toBe('1');
    expect(record!['In Shortlist']).toBe('yes');
  });

  it('shows the effective (overridden) score and names the overridden category', () => {
    const scores = row().categoryScores;
    scores.core_workflow = { rawScore: 12, maxPoints: 25, confidence: 0.9, isOverridden: true };
    const [record] = table(buildResultsFeedbackCsv([row({ categoryScores: scores })]));
    expect(record!['Core Workflow (max 25)']).toBe('12.00');
    expect(record!['Overridden Categories']).toBe('Core Workflow');
  });

  it('flattens feedback into readable cells, improvements by priority', () => {
    const [record] = table(buildResultsFeedbackCsv([row()]));
    expect(record!['Feedback Status']).toBe('ready');
    expect(record!['Feedback Summary']).toBe('A tidy habit tracker.');
    expect(record!['Feedback Strength 1']).toBe('Fast to log');
    expect(record!['Feedback Strength 3']).toBe('Persists on reload');
    expect(record!['Feedback Improvement 1']).toBe('Empty state: The dashboard is blank before the first log.');
    expect(record!['Feedback Improvement 3']).toBe('Mobile layout: The log button is off-screen at 390px.');
    expect(record!['Feedback Bugs / Issues']).toBe(
      'Water intake saves as 0 (evidence: step 4 screenshot)\nConsole error on load (evidence: console)',
    );
    expect(record!['Feedback 7-Day Plan']).toBe('1. Add edit\n2. Fix water field\n3. Ship mobile layout');
  });

  it('keeps a pending-feedback product as a row and says so', () => {
    const rows = [
      row({ rank: 1 }),
      row({ rank: 2, submissionId: 'sub-2', feedback: null, feedbackStatus: 'pending' }),
      row({ rank: 3, submissionId: 'sub-3', feedback: null, feedbackStatus: 'failed', feedbackError: 'Withheld: mentions rank' }),
      row({ rank: 4, submissionId: 'sub-4', feedback: null, feedbackStatus: 'generating' }),
    ];
    const records = table(buildResultsFeedbackCsv(rows));
    expect(records).toHaveLength(4);
    expect(records.map((r) => r['Feedback Status'])).toEqual(['ready', 'pending', 'failed', 'generating']);
    expect(records[1]!['Feedback Summary']).toBe('');
    expect(records[2]!['Feedback Error']).toBe('Withheld: mentions rank');
    // Scores travel regardless of feedback.
    expect(records[2]!['Total Score']).toBe('81.25');
    expect(summariseFeedbackForExport(rows)).toEqual({ ranked: 4, ready: 1, pending: 1, generating: 1, failed: 1 });
  });

  it('treats a stored report as ready even when the status column lags', () => {
    expect(describeFeedbackStatus({ feedback: report(), feedbackStatus: 'pending' })).toBe('ready');
    expect(describeFeedbackStatus({ feedback: null, feedbackStatus: 'generated' })).toBe('pending');
  });

  it('records the winner position and reason, review flags and disqualification', () => {
    const [record] = table(
      buildResultsFeedbackCsv([
        row({
          finalPosition: 2,
          finalSelectionReason: 'Strongest core flow',
          openManualReviewReasons: ['low_confidence_scores', 'browser_never_reached_product'],
          disqualification: { status: 'proposed', reasonCode: 'missing_demo_link', reasonDetail: 'No Loom' },
        }),
      ]),
    );
    expect(record!['Final Winner Position']).toBe('2');
    expect(record!['Final Selection Reason']).toBe('Strongest core flow');
    expect(record!['Manual Review Flag']).toBe('yes');
    expect(record!['Manual Review Reasons']).toBe('low confidence scores; browser never reached product');
    expect(record!['Disqualified']).toBe('no');
    expect(record!['Disqualification Status']).toBe('proposed');
    expect(record!['Disqualification Reason']).toBe('missing demo link: No Loom');
  });

  it('round-trips commas, quotes, line breaks and emoji', () => {
    const [record] = table(
      buildResultsFeedbackCsv([
        row({
          productName: 'Notes, "Quoted" & More 📝',
          feedback: report({
            productSummary: 'Line one\nLine two, with "quotes" — and émojis 🚀',
            strengths: ['Fast, really', 'Says "hi"', 'Multi\nline'],
          }),
        }),
      ]),
    );
    expect(record!['Product Name']).toBe('Notes, "Quoted" & More 📝');
    expect(record!['Feedback Summary']).toBe('Line one\nLine two, with "quotes" — and émojis 🚀');
    expect(record!['Feedback Strength 3']).toBe('Multi\nline');
  });

  it('neutralises spreadsheet formulas in learner-controlled text', () => {
    const csv = buildResultsFeedbackCsv([
      row({
        productName: '=HYPERLINK("https://evil.example","click")',
        feedback: report({
          productSummary: '+1 is not a formula either',
          strengths: ['-cmd', '@SUM(A1)', 'plain'],
          nextSevenDayPlan: ['\tTab first'],
        }),
        loomUrl: '=IMPORTXML("https://evil.example","//a")',
      }),
    ]);
    const [record] = table(csv);
    expect(record!['Product Name']).toMatch(/^'=/);
    expect(record!['Feedback Summary']).toMatch(/^'\+/);
    expect(record!['Feedback Strength 1']).toMatch(/^'-/);
    expect(record!['Feedback Strength 2']).toMatch(/^'@/);
    expect(record!['Loom / Demo URL']).toMatch(/^'=/);
    // No raw cell in the file begins with a formula trigger.
    for (const line of csv.split('\r\n').slice(1)) {
      for (const cell of line.split(',')) {
        expect(cell).not.toMatch(/^[=+\-@]/);
        expect(cell).not.toMatch(/^"[=+\-@]/);
      }
    }
  });

  it('starts with a UTF-8 byte-order mark and CRLF line endings', () => {
    const csv = buildResultsFeedbackCsv([row()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });

  it('contains nothing that could be a credential or an internal path', () => {
    const csv = buildResultsFeedbackCsv([row()]).toLowerCase();
    for (const forbidden of ['password', 'ciphertext', 'token', 'secret', 'api key', 'storage_path', 'bucket', 'prompt']) {
      expect(csv, `export mentions ${forbidden}`).not.toContain(forbidden);
    }
    expect(RESULTS_EXPORT_HEADERS.join(' ').toLowerCase()).not.toMatch(/password|credential|email|phone|token/);
  });

  it('orders rows by stored rank whatever order they arrive in', () => {
    const records = table(buildResultsFeedbackCsv([row({ rank: 5 }), row({ rank: 2 }), row({ rank: 9 })]));
    expect(records.map((r) => r.Rank)).toEqual(['2', '5', '9']);
  });
});

describe('the filename', () => {
  it('names the cohort and the moment, safely', () => {
    expect(resultsExportFilename('AIAP-C14', new Date('2026-09-27T04:30:00.123Z'))).toBe(
      'aiap-c14-results-feedback-2026-09-27T04-30-00Z.csv',
    );
    expect(resultsExportFilename('  ')).toMatch(/^cohort-results-feedback-/);
  });
});
