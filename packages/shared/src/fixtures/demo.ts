/**
 * Deterministic demo fixtures.
 *
 * Everything here is synthetic and obviously so. No historical identity — real
 * or invented — appears anywhere: names are placeholder role labels, emails use
 * the reserved `.invalid` TLD, phone numbers use the reserved 555-01xx range,
 * and product URLs point at `example.com` subdomains that cannot resolve to a
 * real service.
 *
 * Ids are derived from stable names, so a demo can be linked to from
 * documentation and asserted against in tests without churn.
 *
 * Six teams, covering the six scenarios an operator needs to recognise:
 *   12 — complete, strong submission
 *   27 — incomplete draft, never finally submitted
 *   33 — product unreachable at preflight
 *   45 — login-required product with working demo credentials
 *   58 — unsupported product type, routed to manual review
 *   61 — assessable but with weak evidence, flagged low confidence
 */

import { deterministicId, generateReceiptId } from '../domain/ids';
import type { RubricCategoryKey } from '../rubric/index';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../rubric/index';
import type { AssessmentConfig } from '../data/types';
import { IDEA_SEEDS } from './ideas';

const NS = 'ohj-demo';
export const id = (name: string): string => deterministicId(NS, name);

/**
 * Demo clock.
 *
 * Dates are relative to when the process started, so a demo never opens with an
 * expired deadline — a fixed past date made every run look like a missed
 * cohort. The instant is captured ONCE at module load and frozen for the life
 * of the process, so timestamps stay stable across a dev session and within a
 * single test run.
 *
 * Everything else in the fixtures remains deterministic: ids are derived from
 * names, not from time.
 */
const SESSION_START = new Date();

/** Midnight tonight, in the demo cohort's timezone, expressed in UTC. */
function demoDayBoundary(daysFromToday: number, hour: number, minute: number): Date {
  // IST is UTC+5:30 and does not observe daylight saving, so a fixed offset is
  // exact here. A tz-aware calculation would be needed for other zones.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(SESSION_START.getTime() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate() + daysFromToday,
    hour,
    minute,
    0,
    0,
  );
  return new Date(istMidnight - IST_OFFSET_MS);
}

export const DEMO_NOW = SESSION_START;

/**
 * Day 12 opened at 09:00 IST, on the most recent day that has actually passed.
 *
 * "Today at 09:00" is wrong for anyone starting the demo before 09:00 IST — the
 * cohort would not have opened yet, and every editing surface would be
 * read-only. That is a nine-hour window each night in which the demo silently
 * teaches the wrong thing about the product, so the boundary is clamped into
 * the past rather than assumed to be there.
 */
export const DEMO_DAY12_START = (() => {
  const thisMorning = demoDayBoundary(0, 9, 0);
  return thisMorning <= SESSION_START ? thisMorning : demoDayBoundary(-1, 9, 0);
})();
/** Day 13 closes tomorrow at 11:59 PM IST — always in the future. */
export const DEMO_DEADLINE = demoDayBoundary(1, 23, 59);
/** Day 14 shortlist is due the day after, at 10:00 AM IST. */
export const DEMO_SHORTLIST_DUE = demoDayBoundary(2, 10, 0);

export const DEMO_COHORT_ID = id('cohort');
export const DEMO_MODEL_VERSION = 'demo-fixture-model-1';
export const DEMO_PROMPT_VERSION = 'assessment-prompts-v1';

export const DEMO_ASSESSMENT_CONFIG: AssessmentConfig = {
  workerConcurrency: 4,
  browserBudgetMs: 480_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
  gracePeriodMs: 3_600_000,
  consistencyTopN: 20,
  lowConfidenceThreshold: 0.6,
  modelVersion: DEMO_MODEL_VERSION,
  promptVersion: DEMO_PROMPT_VERSION,
};

export const DEMO_COHORT = {
  id: DEMO_COHORT_ID,
  name: 'AI Accelerator — Demo Cohort',
  code: 'AIAPD1',
  description:
    'Demonstration cohort seeded with synthetic teams. No real participant data appears anywhere in this cohort.',
  timezone: 'Asia/Kolkata',
  day12StartAt: DEMO_DAY12_START,
  day13DeadlineAt: DEMO_DEADLINE,
  shortlistTarget: 10,
  submissionInstructions:
    'Build only from the approved product ideas below. Submit your live product URL, a PDF pitch deck using the supplied template, and a demo video of three minutes or less. Your submission locks when you press Final Submit — you can edit freely until then.',
  rubricVersion: RUBRIC_VERSION,
  assessmentConfig: DEMO_ASSESSMENT_CONFIG,
  // Open, so the learner journey is fully explorable in demo mode. Assessment
  // fixtures are pre-seeded regardless of status so the admin side is populated.
  status: 'open' as const,
  finalisedAt: null,
  createdAt: DEMO_DAY12_START,
  updatedAt: DEMO_NOW,
};

/** Assessment fixtures are stamped relative to now, so they read as already done. */
export const hoursAgo = (hours: number): Date => new Date(DEMO_NOW.getTime() - hours * 3_600_000);
export const minutesAgo = (minutes: number): Date => new Date(DEMO_NOW.getTime() - minutes * 60_000);

// --------------------------------------------------------------------------
// Teams
// --------------------------------------------------------------------------

export type DemoScenario =
  | 'complete'
  | 'incomplete'
  | 'inaccessible'
  | 'login_required'
  | 'manual_review'
  | 'low_confidence';

export interface DemoTeamSeed {
  groupNumber: number;
  scenario: DemoScenario;
  ideaSlug: string;
  productName: string;
  memberRoles: string[];
}

/**
 * Names are role labels, not people. This is deliberate: fixtures must never
 * contain anything that could be mistaken for, or become, a real identity.
 */
export const DEMO_TEAMS: readonly DemoTeamSeed[] = [
  {
    groupNumber: 12,
    scenario: 'complete',
    ideaSlug: 'travel-itinerary-planner',
    productName: 'Demo Trip Planner',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)', 'Builder Two (Demo)', 'Designer (Demo)'],
  },
  {
    groupNumber: 27,
    scenario: 'incomplete',
    ideaSlug: 'budget-tracker',
    productName: 'Demo Budget Board',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)'],
  },
  {
    groupNumber: 33,
    scenario: 'inaccessible',
    ideaSlug: 'website-content-scraper',
    productName: 'Demo Page Extractor',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)', 'Builder Two (Demo)'],
  },
  {
    groupNumber: 45,
    scenario: 'login_required',
    ideaSlug: 'collaborative-notetaker',
    productName: 'Demo Shared Notes',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)', 'Builder Two (Demo)'],
  },
  {
    groupNumber: 58,
    scenario: 'manual_review',
    ideaSlug: 'fitness-goal-tracker',
    productName: 'Demo Fitness Companion',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)'],
  },
  {
    groupNumber: 61,
    scenario: 'low_confidence',
    ideaSlug: 'movie-watchlist',
    productName: 'Demo Watch Queue',
    memberRoles: ['Team Lead (Demo)', 'Builder One (Demo)', 'Builder Two (Demo)'],
  },
] as const;

/**
 * How each scenario is described to an operator exploring the demo.
 *
 * The point of the six teams is that an operator can recognise each situation
 * on the night, so the labels describe the *situation*, not the fixture.
 */
export const DEMO_SCENARIO_META: Record<
  DemoScenario,
  { label: string; summary: string; tone: 'success' | 'neutral' | 'warning' | 'danger' | 'info' }
> = {
  complete: {
    label: 'Complete final submission',
    summary:
      'Everything supplied and the product works. The core workflow ran end to end twice and data survived a reload.',
    tone: 'success',
  },
  incomplete: {
    label: 'Draft in progress',
    summary:
      'Started but never finally submitted. Use this one to walk through the six submission steps yourself.',
    tone: 'neutral',
  },
  login_required: {
    label: 'Login-required product',
    summary:
      'Needs an account, so the team supplied demo credentials. They are encrypted and masked, and never sent to an AI model.',
    tone: 'info',
  },
  inaccessible: {
    label: 'Inaccessible product',
    summary:
      'The product URL never resolved. Preflight retried three times and recorded every attempt before proposing anything.',
    tone: 'danger',
  },
  manual_review: {
    label: 'Manual-review case',
    summary:
      'A native mobile app, which automated browser testing cannot assess. Routed to a human rather than penalised.',
    tone: 'warning',
  },
  low_confidence: {
    label: 'Low-confidence assessment',
    summary:
      'Assessed, but the run hit its time budget and the deck could not be read. Scored provisionally and flagged.',
    tone: 'warning',
  },
};

/**
 * A stable access code per demo team.
 *
 * Derived from the group number so the demo home can print working codes and an
 * operator can exercise the real /submit verification flow. Digits 0 and 1 and
 * letters I, L, O, U are absent from the alphabet, so a group number cannot be
 * embedded literally — the code is a deterministic mapping instead.
 */
const DEMO_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function demoAccessCode(groupNumber: number): string {
  const digest = deterministicId(NS, `access-code-${groupNumber}`).replace(/-/g, '');
  let code = '';
  for (let i = 0; i < 12; i++) {
    const value = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    code += DEMO_CODE_ALPHABET[value % DEMO_CODE_ALPHABET.length];
  }
  return code;
}

export const demoTeamId = (groupNumber: number) => id(`team-${groupNumber}`);
export const demoSubmissionId = (groupNumber: number) => id(`submission-${groupNumber}`);
export const demoJobId = (groupNumber: number) => id(`job-${groupNumber}`);

/** Reserved-range contact details, safe to display and impossible to reach. */
export const demoEmail = (groupNumber: number) => `group${groupNumber}.lead@demo.invalid`;
export const demoPhone = (groupNumber: number) => `+1 555 01${String(groupNumber).padStart(2, '0')}`;
export const demoProductUrl = (slug: string, groupNumber: number) =>
  `https://group-${groupNumber}-${slug}.example.com`;

// --------------------------------------------------------------------------
// Deterministic scoring
// --------------------------------------------------------------------------

/**
 * Score profiles per scenario, expressed as a fraction of each category's max.
 *
 * Hand-tuned rather than random so the demo tells a coherent story: the strong
 * submission wins on core workflow, the login-required one loses a little on
 * entry friction, and the low-confidence one is mid-table with thin evidence.
 */
const SCORE_PROFILES: Record<
  Exclude<DemoScenario, 'incomplete' | 'inaccessible' | 'manual_review'>,
  Record<RubricCategoryKey, { fraction: number; confidence: number }>
> = {
  complete: {
    problem_clarity: { fraction: 0.87, confidence: 0.9 },
    core_workflow: { fraction: 0.92, confidence: 0.95 },
    solution_usefulness: { fraction: 0.87, confidence: 0.92 },
    ai_usefulness: { fraction: 0.8, confidence: 0.85 },
    two_day_execution: { fraction: 0.85, confidence: 0.88 },
    ease_of_use: { fraction: 0.75, confidence: 0.9 },
    practical_potential: { fraction: 0.8, confidence: 0.7 },
    deck_demo: { fraction: 0.9, confidence: 0.85 },
  },
  login_required: {
    problem_clarity: { fraction: 0.73, confidence: 0.85 },
    core_workflow: { fraction: 0.72, confidence: 0.88 },
    solution_usefulness: { fraction: 0.67, confidence: 0.85 },
    ai_usefulness: { fraction: 0.6, confidence: 0.8 },
    two_day_execution: { fraction: 0.7, confidence: 0.85 },
    ease_of_use: { fraction: 0.6, confidence: 0.88 },
    practical_potential: { fraction: 0.6, confidence: 0.7 },
    deck_demo: { fraction: 0.7, confidence: 0.8 },
  },
  low_confidence: {
    problem_clarity: { fraction: 0.6, confidence: 0.55 },
    core_workflow: { fraction: 0.52, confidence: 0.45 },
    solution_usefulness: { fraction: 0.53, confidence: 0.5 },
    ai_usefulness: { fraction: 0.4, confidence: 0.35 },
    two_day_execution: { fraction: 0.6, confidence: 0.7 },
    ease_of_use: { fraction: 0.5, confidence: 0.6 },
    practical_potential: { fraction: 0.6, confidence: 0.5 },
    deck_demo: { fraction: 0.4, confidence: 0.3 },
  },
};

export interface DemoScore {
  categoryKey: RubricCategoryKey;
  rawScore: number;
  maxPoints: number;
  weightedScore: number;
  confidence: number;
  rationale: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  missingEvidence: string[];
}

export function buildDemoScores(scenario: DemoScenario): DemoScore[] {
  const profile = SCORE_PROFILES[scenario as keyof typeof SCORE_PROFILES];
  if (!profile) return [];

  return RUBRIC_CATEGORIES.map((category) => {
    const entry = profile[category.key];
    const raw = Math.round(category.maxPoints * entry.fraction * 4) / 4;
    const narrative = SCORE_NARRATIVES[scenario]?.[category.key];
    return {
      categoryKey: category.key,
      rawScore: raw,
      maxPoints: category.maxPoints,
      weightedScore: raw,
      confidence: entry.confidence,
      rationale: narrative?.rationale ?? `Scored from observed evidence for ${category.title.toLowerCase()}.`,
      supportingEvidence: narrative?.supporting ?? [],
      contradictoryEvidence: narrative?.contradictory ?? [],
      missingEvidence: narrative?.missing ?? [],
    };
  });
}

interface Narrative {
  rationale: string;
  supporting: string[];
  contradictory: string[];
  missing: string[];
}

/**
 * Evidence narratives.
 *
 * Written as though produced by the real pipeline — each references an
 * observable artifact (a step, a screenshot, a console record) rather than an
 * opinion, because "every score has evidence" is an acceptance criterion and
 * the demo has to demonstrate what that looks like.
 */
const SCORE_NARRATIVES: Partial<Record<DemoScenario, Partial<Record<RubricCategoryKey, Narrative>>>> = {
  complete: {
    problem_clarity: {
      rationale:
        'Named a specific user and a concrete recurring pain, and the live product matches the stated promise.',
      supporting: [
        'Written submission names a specific traveller profile and the scattered-plans problem.',
        'Deck slide 3 states a one-line problem with three supporting points.',
        'Landing page headline matches the submitted one-sentence promise.',
      ],
      contradictory: [],
      missing: [],
    },
    core_workflow: {
      rationale:
        'The declared must-have workflow completed end to end twice, including edit and delete.',
      supporting: [
        'Steps 3–9: created a trip, days auto-generated, added three activities.',
        'Steps 11–14: edited an activity time and deleted an activity successfully.',
        'Second pass (steps 22–28) repeated the full flow with the same result.',
      ],
      contradictory: [],
      missing: [],
    },
    solution_usefulness: {
      rationale: 'Data persisted across reload and no console or network errors were recorded.',
      supporting: [
        'Persistence check after reload: created activity still present.',
        'Console check: 0 errors across 31 steps.',
        'Network check: 0 failed requests.',
      ],
      contradictory: [],
      missing: ['Multi-session consistency was not exercised — the product is single-user.'],
    },
    ai_usefulness: {
      rationale:
        'The AI suggestion feature used trip context and produced usable output that could be added to the itinerary.',
      supporting: [
        'Step 17: AI suggestions returned three activities scoped to the trip destination.',
        'Step 18: a suggestion was accepted and appeared as a real activity.',
      ],
      contradictory: [],
      missing: ['AI failure handling was not observable — no failure occurred during the run.'],
    },
    two_day_execution: {
      rationale: 'Three specific bugs with concrete fixes, and a real trade-off with a stated cost.',
      supporting: [
        'Bug log describes a date-boundary defect with the fix applied.',
        'Trade-off states map view was dropped to finish the edit flow.',
        'Day 12 → Day 13 changes are specific and verifiable against the product.',
      ],
      contradictory: [],
      missing: [],
    },
    ease_of_use: {
      rationale: 'Clean flow and good states, with a small number of moderate accessibility issues.',
      supporting: [
        'Loading and empty states observed on the trip list.',
        'Mobile smoke test completed the core flow at 390×844.',
        'Keyboard traversal reached all primary actions.',
      ],
      contradictory: ['axe scan: 4 moderate violations (colour contrast on secondary text).'],
      missing: [],
    },
    practical_potential: {
      rationale: 'Clear repeat-use reason and an identifiable audience.',
      supporting: ['Per-trip usage model implies natural repeat use.', 'Audience is specific and reachable.'],
      contradictory: [],
      missing: ['No evidence of a monetisation path was submitted or observed.'],
    },
    deck_demo: {
      rationale: 'Deck is complete, on-template, and accurately represents the live product.',
      supporting: [
        'Deck: 8 pages, all template placeholders replaced.',
        'Deck screenshots match the live product.',
        'Demo link resolved and is within the three-minute limit as declared.',
      ],
      contradictory: [],
      missing: [],
    },
  },
  login_required: {
    problem_clarity: {
      rationale: 'Clear team-notes use case, though the target user is described broadly.',
      supporting: ['Submission describes a shared-notes problem for small teams.'],
      contradictory: ['Primary user is described as "teams and students", which spans two audiences.'],
      missing: [],
    },
    core_workflow: {
      rationale: 'Core note lifecycle worked after login; sharing was only partly exercised.',
      supporting: [
        'Steps 4–10: logged in with supplied demo credentials, created and edited a note.',
        'Step 12: note list reflected the edit.',
      ],
      contradictory: ['Step 15: share dialog opened but the generated link returned a 404.'],
      missing: ['Real-time collaboration could not be verified from a single browser context.'],
    },
    solution_usefulness: {
      rationale: 'Notes persisted, but two console errors were recorded during sharing.',
      supporting: ['Persistence check after reload: note content intact.'],
      contradictory: ['Console: 2 errors thrown from the share handler.'],
      missing: [],
    },
    ai_usefulness: {
      rationale: 'Summarisation worked on note content but output was generic.',
      supporting: ['Step 18: summarise returned a summary of the created note.'],
      contradictory: ['Summary did not reflect specifics of the note body.'],
      missing: ['AI failure state not observed.'],
    },
    two_day_execution: {
      rationale: 'Bugs and trade-off are described concretely, if briefly.',
      supporting: ['Three bugs listed with fixes.', 'Trade-off explains dropping offline support.'],
      contradictory: [],
      missing: [],
    },
    ease_of_use: {
      rationale: 'Usable but login-first, and several accessibility issues.',
      supporting: ['Mobile smoke test passed.'],
      contradictory: [
        'axe scan: 2 serious, 6 moderate violations.',
        'No guest path — value is only visible after authentication.',
      ],
      missing: [],
    },
    practical_potential: {
      rationale: 'Plausible team-product path.',
      supporting: ['Shared-notes products have a clear team adoption route.'],
      contradictory: [],
      missing: ['No differentiation from existing note tools was evidenced.'],
    },
    deck_demo: {
      rationale: 'Deck covers the product but two template placeholders remain.',
      supporting: ['Deck: 8 pages, problem and demo slides completed.'],
      contradictory: ['Two team-slide placeholders were left unedited.'],
      missing: [],
    },
  },
  low_confidence: {
    problem_clarity: {
      rationale: 'Problem is stated but generic, and the deck could not be fully read.',
      supporting: ['Submission describes a watchlist problem.'],
      contradictory: ['Primary user is "movie lovers", which is not specific.'],
      missing: ['Deck text extraction returned only 2 of 9 pages — the deck is largely images.'],
    },
    core_workflow: {
      rationale:
        'Search and add worked, but the run hit the time budget before the rating flow completed.',
      supporting: ['Steps 3–7: searched and added a film to the watchlist.'],
      contradictory: [],
      missing: [
        'Rating flow was not reached before the 8-minute budget elapsed.',
        'Mark-as-watched was not verified.',
      ],
    },
    solution_usefulness: {
      rationale: 'Persistence held for the one entity tested; broader CRUD is unverified.',
      supporting: ['Persistence check after reload: watchlist entry present.'],
      contradictory: ['Console: 1 error during search.'],
      missing: ['Update and delete were not exercised.'],
    },
    ai_usefulness: {
      rationale: 'An AI recommendation surface exists but did not return output during the run.',
      supporting: ['A "recommend for me" control is present.'],
      contradictory: ['Step 14: control was clicked and no result rendered within 15 seconds.'],
      missing: ['No successful AI output was observed, so usefulness could not be assessed.'],
    },
    two_day_execution: {
      rationale: 'Bugs are described, though two of the three are phrased generically.',
      supporting: ['One bug describes a concrete search defect and its fix.'],
      contradictory: ['Two bug entries describe "UI issues" without specifics.'],
      missing: [],
    },
    ease_of_use: {
      rationale: 'Basic flow is usable; accessibility scan found several issues.',
      supporting: ['Mobile smoke test loaded and rendered the list.'],
      contradictory: ['axe scan: 1 critical, 5 moderate violations.'],
      missing: ['Keyboard traversal incomplete — the run ended early.'],
    },
    practical_potential: {
      rationale: 'A familiar category with a plausible audience.',
      supporting: ['Watchlist products have an established audience.'],
      contradictory: [],
      missing: ['No differentiation or monetisation evidence was submitted.'],
    },
    deck_demo: {
      rationale: 'Deck is image-heavy and unreadable to text extraction; the demo video could not be analysed.',
      supporting: ['Deck file is present, valid, and 9 pages.'],
      contradictory: [],
      missing: [
        'Deck text could not be extracted from 7 of 9 pages.',
        'Demo video could not be retrieved for analysis — video_analysis_limited was set.',
      ],
    },
  },
};

// --------------------------------------------------------------------------
// Browser evidence
// --------------------------------------------------------------------------

export interface DemoBrowserRun {
  viewport: 'desktop' | 'mobile';
  status: 'passed' | 'partial' | 'failed' | 'error';
  durationMs: number;
  consoleErrorCount: number;
  networkFailureCount: number;
  a11yViolationCount: number;
  a11ySummary: { critical: number; serious: number; moderate: number; minor: number };
  cleanupStatus: 'complete' | 'partial' | 'not_attempted' | 'failed';
  timedOut: boolean;
  steps: { action: string; status: 'passed' | 'failed' | 'skipped' | 'error'; durationMs: number; detail: string }[];
}

export const DEMO_BROWSER_RUNS: Partial<Record<DemoScenario, DemoBrowserRun[]>> = {
  complete: [
    {
      viewport: 'desktop',
      status: 'passed',
      durationMs: 214_300,
      consoleErrorCount: 0,
      networkFailureCount: 0,
      a11yViolationCount: 4,
      a11ySummary: { critical: 0, serious: 0, moderate: 4, minor: 2 },
      cleanupStatus: 'complete',
      timedOut: false,
      steps: [
        { action: 'navigate', status: 'passed', durationMs: 1840, detail: 'Loaded product entry URL (200).' },
        { action: 'screenshot', status: 'passed', durationMs: 420, detail: 'landing' },
        { action: 'click', status: 'passed', durationMs: 310, detail: 'button "Create trip"' },
        { action: 'fill', status: 'passed', durationMs: 190, detail: 'textbox "Destination" ← OUTSKILL-JUDGE-Item K3M9QX' },
        { action: 'fill', status: 'passed', durationMs: 160, detail: 'textbox "Start date" ← 2030-06-15' },
        { action: 'click', status: 'passed', durationMs: 890, detail: 'button "Save trip"' },
        { action: 'assertText', status: 'passed', durationMs: 240, detail: 'Trip title visible' },
        { action: 'click', status: 'passed', durationMs: 300, detail: 'button "Add activity"' },
        { action: 'fill', status: 'passed', durationMs: 180, detail: 'textbox "Activity" ← OUTSKILL-JUDGE-Item 8PQ2VR' },
        { action: 'click', status: 'passed', durationMs: 640, detail: 'button "Save activity"' },
        { action: 'reload', status: 'passed', durationMs: 1420, detail: 'Page reloaded' },
        { action: 'checkPersistence', status: 'passed', durationMs: 380, detail: 'Activity survived reload' },
        { action: 'click', status: 'passed', durationMs: 290, detail: 'button "Edit" on activity' },
        { action: 'fill', status: 'passed', durationMs: 170, detail: 'textbox "Time" ← 10:30' },
        { action: 'click', status: 'passed', durationMs: 520, detail: 'button "Save"' },
        { action: 'assertText', status: 'passed', durationMs: 210, detail: 'Updated time visible' },
        { action: 'click', status: 'passed', durationMs: 280, detail: 'button "Ask AI for ideas"' },
        { action: 'wait', status: 'passed', durationMs: 3200, detail: 'AI panel rendered 3 suggestions' },
        { action: 'click', status: 'passed', durationMs: 340, detail: 'button "Add suggestion"' },
        { action: 'assertElement', status: 'passed', durationMs: 200, detail: 'Suggestion added to day 1' },
        { action: 'checkConsole', status: 'passed', durationMs: 60, detail: '0 console errors' },
        { action: 'checkNetwork', status: 'passed', durationMs: 60, detail: '0 failed requests' },
        { action: 'a11yScan', status: 'passed', durationMs: 2100, detail: '4 moderate, 2 minor violations' },
        { action: 'cleanup', status: 'passed', durationMs: 1180, detail: 'Removed 3 OUTSKILL-JUDGE- records' },
      ],
    },
    {
      viewport: 'mobile',
      status: 'passed',
      durationMs: 61_200,
      consoleErrorCount: 0,
      networkFailureCount: 0,
      a11yViolationCount: 3,
      a11ySummary: { critical: 0, serious: 0, moderate: 3, minor: 1 },
      cleanupStatus: 'complete',
      timedOut: false,
      steps: [
        { action: 'navigate', status: 'passed', durationMs: 1610, detail: 'Loaded at 390×844 (200).' },
        { action: 'screenshot', status: 'passed', durationMs: 380, detail: 'mobile-landing' },
        { action: 'click', status: 'passed', durationMs: 340, detail: 'button "Create trip"' },
        { action: 'assertElement', status: 'passed', durationMs: 220, detail: 'Form usable at mobile width' },
        { action: 'a11yScan', status: 'passed', durationMs: 1900, detail: '3 moderate, 1 minor violations' },
      ],
    },
  ],
  login_required: [
    {
      viewport: 'desktop',
      status: 'partial',
      durationMs: 268_900,
      consoleErrorCount: 2,
      networkFailureCount: 1,
      a11yViolationCount: 8,
      a11ySummary: { critical: 0, serious: 2, moderate: 6, minor: 3 },
      cleanupStatus: 'partial',
      timedOut: false,
      steps: [
        { action: 'navigate', status: 'passed', durationMs: 2010, detail: 'Loaded product entry URL (200).' },
        { action: 'fill', status: 'passed', durationMs: 210, detail: 'textbox "Email" ← [demo credential, masked]' },
        { action: 'fill', status: 'passed', durationMs: 190, detail: 'textbox "Password" ← [demo credential, masked]' },
        { action: 'click', status: 'passed', durationMs: 1240, detail: 'button "Sign in"' },
        { action: 'assertUrl', status: 'passed', durationMs: 180, detail: 'URL contains /notes' },
        { action: 'click', status: 'passed', durationMs: 300, detail: 'button "New note"' },
        { action: 'fill', status: 'passed', durationMs: 200, detail: 'textbox "Title" ← OUTSKILL-JUDGE-Item M4T7WZ' },
        { action: 'click', status: 'passed', durationMs: 700, detail: 'button "Save"' },
        { action: 'reload', status: 'passed', durationMs: 1500, detail: 'Page reloaded' },
        { action: 'checkPersistence', status: 'passed', durationMs: 400, detail: 'Note survived reload' },
        { action: 'click', status: 'passed', durationMs: 280, detail: 'button "Share"' },
        { action: 'click', status: 'failed', durationMs: 4200, detail: 'Generated share link returned HTTP 404' },
        { action: 'click', status: 'passed', durationMs: 320, detail: 'button "Summarise with AI"' },
        { action: 'wait', status: 'passed', durationMs: 4100, detail: 'Summary rendered' },
        { action: 'checkConsole', status: 'failed', durationMs: 60, detail: '2 console errors from share handler' },
        { action: 'checkNetwork', status: 'failed', durationMs: 60, detail: '1 failed request: GET /s/abc123 → 404' },
        { action: 'a11yScan', status: 'passed', durationMs: 2400, detail: '2 serious, 6 moderate violations' },
        { action: 'cleanup', status: 'passed', durationMs: 900, detail: 'Removed 1 of 2 OUTSKILL-JUDGE- records' },
      ],
    },
  ],
  low_confidence: [
    {
      viewport: 'desktop',
      status: 'partial',
      durationMs: 480_000,
      consoleErrorCount: 1,
      networkFailureCount: 0,
      a11yViolationCount: 6,
      a11ySummary: { critical: 1, serious: 0, moderate: 5, minor: 2 },
      cleanupStatus: 'partial',
      timedOut: true,
      steps: [
        { action: 'navigate', status: 'passed', durationMs: 3400, detail: 'Loaded product entry URL (200), slow first paint.' },
        { action: 'fill', status: 'passed', durationMs: 220, detail: 'searchbox "Search films" ← OUTSKILL-JUDGE-Item R2N8KD' },
        { action: 'click', status: 'passed', durationMs: 8400, detail: 'button "Search" — results after 8.4s' },
        { action: 'click', status: 'passed', durationMs: 520, detail: 'button "Add to watchlist"' },
        { action: 'reload', status: 'passed', durationMs: 3100, detail: 'Page reloaded' },
        { action: 'checkPersistence', status: 'passed', durationMs: 600, detail: 'Watchlist entry present' },
        { action: 'click', status: 'passed', durationMs: 400, detail: 'button "Recommend for me"' },
        { action: 'wait', status: 'failed', durationMs: 15_000, detail: 'No AI output rendered within 15s' },
        { action: 'checkConsole', status: 'failed', durationMs: 60, detail: '1 console error during search' },
        { action: 'a11yScan', status: 'passed', durationMs: 2600, detail: '1 critical, 5 moderate violations' },
        { action: 'click', status: 'skipped', durationMs: 0, detail: 'Rating flow not reached — budget exhausted' },
        { action: 'cleanup', status: 'passed', durationMs: 1100, detail: 'Removed 1 OUTSKILL-JUDGE- record' },
      ],
    },
  ],
};

// --------------------------------------------------------------------------
// Preflight
// --------------------------------------------------------------------------

export interface DemoPreflightCheck {
  checkKey: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  attemptNumber: number;
  failureClass: 'timeout' | 'dns' | 'auth' | 'server' | 'blocked' | 'invalid' | 'none';
  detail: string;
}

export const PREFLIGHT_CHECK_KEYS = [
  'completeness',
  'deadline',
  'approved_idea',
  'url_valid',
  'dns_resolves',
  'http_reachable',
  'https_enforced',
  'redirects_sane',
  'deck_readable',
  'demo_link_accessible',
  'credentials_present',
  'duplicate_submission',
  'unsafe_url',
  'product_type_supported',
] as const;

export function buildDemoPreflight(scenario: DemoScenario): DemoPreflightCheck[] {
  const pass = (checkKey: string, detail: string): DemoPreflightCheck => ({
    checkKey,
    status: 'pass',
    attemptNumber: 1,
    failureClass: 'none',
    detail,
  });

  const base: DemoPreflightCheck[] = [
    pass('completeness', 'All required fields present.'),
    pass('deadline', 'Submitted before the Day 13 deadline.'),
    pass('approved_idea', 'Selected idea is active for this cohort.'),
    pass('url_valid', 'Product URL is a valid HTTPS address.'),
    pass('unsafe_url', 'URL does not resolve to a private or blocked address.'),
    pass('duplicate_submission', 'One submission for this team in this cohort.'),
  ];

  switch (scenario) {
    case 'complete':
      return [
        ...base,
        pass('dns_resolves', 'Hostname resolved to a public address.'),
        pass('http_reachable', 'GET returned 200 in 480 ms.'),
        pass('https_enforced', 'HTTP redirects to HTTPS.'),
        pass('redirects_sane', '1 redirect, same origin.'),
        pass('deck_readable', 'PDF parsed: 8 pages, text extracted from all pages.'),
        pass('demo_link_accessible', 'Demo link returned 200.'),
        { ...pass('credentials_present', 'Not required — product is usable as a guest.'), status: 'skipped' },
        pass('product_type_supported', 'Public HTTPS web application — fully supported.'),
      ];

    case 'login_required':
      return [
        ...base,
        pass('dns_resolves', 'Hostname resolved to a public address.'),
        pass('http_reachable', 'GET returned 200 in 610 ms.'),
        pass('https_enforced', 'HTTPS enforced.'),
        pass('redirects_sane', '2 redirects to /login, same origin.'),
        pass('deck_readable', 'PDF parsed: 8 pages, text extracted from all pages.'),
        pass('demo_link_accessible', 'Demo link returned 200.'),
        pass('credentials_present', 'Demo credentials supplied and stored encrypted.'),
        pass('product_type_supported', 'Public HTTPS web application with demo credentials — supported.'),
      ];

    case 'inaccessible':
      return [
        ...base.filter((c) => c.checkKey !== 'completeness'),
        pass('completeness', 'All required fields present.'),
        {
          checkKey: 'dns_resolves',
          status: 'fail',
          attemptNumber: 1,
          failureClass: 'dns',
          detail: 'DNS lookup failed: NXDOMAIN.',
        },
        {
          checkKey: 'dns_resolves',
          status: 'fail',
          attemptNumber: 2,
          failureClass: 'dns',
          detail: 'DNS lookup failed: NXDOMAIN. Retried after 60s.',
        },
        {
          checkKey: 'dns_resolves',
          status: 'fail',
          attemptNumber: 3,
          failureClass: 'dns',
          detail: 'DNS lookup failed: NXDOMAIN. Retried after 300s. Retries exhausted.',
        },
        {
          checkKey: 'http_reachable',
          status: 'fail',
          attemptNumber: 3,
          failureClass: 'dns',
          detail: 'Could not connect — hostname does not resolve.',
        },
        pass('deck_readable', 'PDF parsed: 7 pages, text extracted.'),
        pass('demo_link_accessible', 'Demo link returned 200.'),
        { ...pass('credentials_present', 'Not applicable — product unreachable.'), status: 'skipped' },
        {
          checkKey: 'product_type_supported',
          status: 'warn',
          attemptNumber: 1,
          failureClass: 'none',
          detail: 'Product type could not be determined because the product was unreachable.',
        },
      ];

    case 'manual_review':
      return [
        ...base,
        pass('dns_resolves', 'Hostname resolved to a public address.'),
        pass('http_reachable', 'GET returned 200 in 520 ms.'),
        pass('https_enforced', 'HTTPS enforced.'),
        pass('redirects_sane', 'No redirects.'),
        pass('deck_readable', 'PDF parsed: 6 pages, text extracted.'),
        pass('demo_link_accessible', 'Demo link returned 200.'),
        { ...pass('credentials_present', 'Not applicable.'), status: 'skipped' },
        {
          checkKey: 'product_type_supported',
          status: 'fail',
          attemptNumber: 1,
          failureClass: 'invalid',
          detail:
            'The URL serves an app-store listing for a native mobile application, not a web application. Automated browser testing cannot assess this product type — routed to manual review.',
        },
      ];

    case 'low_confidence':
      return [
        ...base,
        pass('dns_resolves', 'Hostname resolved to a public address.'),
        pass('http_reachable', 'GET returned 200 in 3.4 s.'),
        pass('https_enforced', 'HTTPS enforced.'),
        pass('redirects_sane', 'No redirects.'),
        {
          checkKey: 'deck_readable',
          status: 'warn',
          attemptNumber: 1,
          failureClass: 'none',
          detail: 'PDF parsed: 9 pages, but text extracted from only 2 — the deck is largely images.',
        },
        {
          checkKey: 'demo_link_accessible',
          status: 'warn',
          attemptNumber: 2,
          failureClass: 'timeout',
          detail: 'Demo link timed out twice. Marked video_analysis_limited; not treated as a missing demo.',
        },
        { ...pass('credentials_present', 'Not required — product is usable as a guest.'), status: 'skipped' },
        pass('product_type_supported', 'Public HTTPS web application — fully supported.'),
      ];

    case 'incomplete':
      return [
        {
          checkKey: 'completeness',
          status: 'fail',
          attemptNumber: 1,
          failureClass: 'invalid',
          detail: 'Submission is still a draft — it was never finally submitted.',
        },
      ];

    default: {
      const exhaustive: never = scenario;
      throw new Error(`Unhandled scenario: ${String(exhaustive)}`);
    }
  }
}

// --------------------------------------------------------------------------
// Feedback reports (generated, stored, exposed to nobody in Version 1)
// --------------------------------------------------------------------------

export interface DemoFeedback {
  productSummary: string;
  strengths: string[];
  improvements: { title: string; detail: string; priority: number }[];
  bugs: { description: string; evidence: string }[];
  nextSevenDayPlan: string[];
}

export const DEMO_FEEDBACK: Partial<Record<DemoScenario, DemoFeedback>> = {
  complete: {
    productSummary:
      'A day-wise trip planner that lets a traveller create a trip, auto-generate days, and manage activities, with an AI suggestion panel scoped to the destination.',
    strengths: [
      'The core planning flow completed end to end twice with no errors, including edit and delete — the solution_usefulness bar you were given was met.',
      'Activities persisted correctly across a reload, which means the product has a real backend rather than in-page state.',
      'The AI suggestion panel used trip context and produced items that could be added directly to a day, so AI changes the outcome rather than decorating it.',
    ],
    improvements: [
      {
        title: 'Raise contrast on secondary text',
        detail:
          'An accessibility scan found four moderate contrast issues on secondary text. Darkening that text is a small change that makes the itinerary readable in daylight on a phone.',
        priority: 1,
      },
      {
        title: 'Handle the AI failure path',
        detail:
          'The suggestion panel worked during testing, so its failure behaviour was never observed. Add a visible error and a retry so a slow or failed suggestion call does not leave an empty panel.',
        priority: 2,
      },
      {
        title: 'Make repeat use concrete',
        detail:
          'The product is used once per trip. A saved-trips view or a duplicate-trip action would give a returning traveller a reason to come back rather than starting over.',
        priority: 3,
      },
    ],
    bugs: [],
    nextSevenDayPlan: [
      'Fix the four contrast issues found by the accessibility scan.',
      'Add error and retry states to the AI suggestion panel.',
      'Add a trip duplicate action to support repeat use.',
      'Test the full flow with three people who have never seen the product.',
    ],
  },
  login_required: {
    productSummary:
      'A shared notes product with authentication, note CRUD, a sharing feature, and AI summarisation of note content.',
    strengths: [
      'Note creation, editing and persistence all worked reliably after login.',
      'The AI summarisation feature ran against real note content rather than a canned response.',
      'Demo credentials were supplied and worked first time, which made the product fully assessable.',
    ],
    improvements: [
      {
        title: 'Fix the share link',
        detail:
          'The share dialog generated a link that returned 404, and two console errors came from the same handler. Sharing is central to a collaborative notetaker, so this is the highest-value fix.',
        priority: 1,
      },
      {
        title: 'Let people see value before signing in',
        detail:
          'Everything is behind the login. A read-only sample note reachable without an account would let someone understand the product in seconds.',
        priority: 2,
      },
      {
        title: 'Address the two serious accessibility issues',
        detail:
          'The scan found two serious violations alongside six moderate ones. The serious ones affect people using assistive technology and are worth fixing first.',
        priority: 3,
      },
    ],
    bugs: [
      {
        description: 'Generated share links return HTTP 404.',
        evidence: 'Share dialog opened, link generated, GET /s/abc123 returned 404. Two console errors recorded from the share handler.',
      },
    ],
    nextSevenDayPlan: [
      'Fix share link generation and the console errors it produces.',
      'Add a public read-only sample note so value is visible before signup.',
      'Fix the two serious accessibility violations.',
      'Verify real-time collaboration with two browsers open at once.',
    ],
  },
  low_confidence: {
    productSummary:
      'A film watchlist product with search, watchlist management, and an AI recommendation control.',
    strengths: [
      'Search and add-to-watchlist worked, and the watchlist survived a reload — the data layer is real.',
      'The product loaded and rendered its list correctly on a mobile viewport.',
      'One of the three bugs you reported describes a concrete search defect and its fix clearly.',
    ],
    improvements: [
      {
        title: 'Make search fast enough to use',
        detail:
          'Search took 8.4 seconds to return results and produced a console error. On a discovery product, that delay is the product. This is the first thing to fix.',
        priority: 1,
      },
      {
        title: 'Make the AI recommendation return something',
        detail:
          'The "Recommend for me" control was clicked and nothing rendered within 15 seconds — no result, no error, no loading state. Even a failure message would be better than silence.',
        priority: 2,
      },
      {
        title: 'Fix the critical accessibility violation',
        detail:
          'The scan found one critical violation. Critical issues typically block assistive technology entirely, so this one is worth fixing before the moderate ones.',
        priority: 3,
      },
    ],
    bugs: [
      {
        description: 'Search takes over 8 seconds and logs a console error.',
        evidence: 'Search click → results after 8,400 ms; 1 console error recorded during the search request.',
      },
      {
        description: 'The AI recommendation control produces no output and no error.',
        evidence: 'Clicked "Recommend for me"; no content rendered within a 15-second wait; no loading or error state shown.',
      },
    ],
    nextSevenDayPlan: [
      'Profile and fix search latency, and resolve the console error it produces.',
      'Add loading, success and error states to the AI recommendation control.',
      'Fix the critical accessibility violation.',
      'Re-export the pitch deck with selectable text rather than images.',
    ],
  },
};

/** Ideas indexed by slug, for fixture wiring. */
export const IDEA_BY_SLUG = new Map(IDEA_SEEDS.map((idea) => [idea.slug, idea]));

export function demoReceiptId(groupNumber: number): string {
  // Deterministic rather than random, so demo receipts are stable across runs.
  const suffix = deterministicId(NS, `receipt-${groupNumber}`).replace(/-/g, '').toUpperCase();
  const random = suffix.replace(/[ILOU]/g, 'X').slice(0, 6);
  return `OSK-${DEMO_COHORT.code}-${String(groupNumber).padStart(3, '0')}-${random}`;
}

/** Kept exported so a non-demo caller has a single obvious entry point. */
export { generateReceiptId };
