/**
 * Deterministic responder for the demo provider.
 *
 * Produces structurally valid output for every prompt so the whole pipeline can
 * run with no AI key. Responses key off the prompt content rather than a passed
 * flag, so the demo path exercises the same call sites as production.
 *
 * These are fixtures, not a model. They are plausible and schema-valid; they
 * are not an assessment of anything.
 */

import { RUBRIC_CATEGORIES } from '@ohj/shared/client';
import type { ArtifactAnalysisOutput, FeedbackOutput, ScoringOutput, TestPlanOutput } from './schemas';

export function demoResponder(system: string, user: string): unknown {
  if (system.includes('analyse hackathon submission material')) return artifactAnalysis(user);
  if (system.includes('browser test plan')) return testPlan(user);
  if (system.includes('score one hackathon submission')) return scoring(user);
  if (system.includes('reviewing a first-pass score')) return consistency();
  if (system.includes('constructive feedback')) return feedback(user);
  throw new Error('Demo responder received an unrecognised prompt.');
}

/** Stable pseudo-random in [0,1) derived from the prompt, so runs repeat exactly. */
function seededUnit(input: string, salt: string): number {
  let h = 2166136261;
  const text = input + salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

function extractUrl(user: string): string {
  return /Product URL:\s*(\S+)/.exec(user)?.[1] ?? 'https://example.com';
}

function artifactAnalysis(user: string): ArtifactAnalysisOutput {
  const deckAvailable = !user.includes('No text could be extracted');
  return {
    deck: {
      coversProblem: deckAvailable,
      coversProduct: deckAvailable,
      coversDemo: deckAvailable,
      placeholdersRemaining: deckAvailable ? 0 : 0,
      templateCompliance: deckAvailable ? 'complete' : 'none',
      claimsMade: deckAvailable
        ? [
            'The product supports the full declared core workflow.',
            'An AI feature assists the user within the workflow.',
            'Data is stored and persists between sessions.',
          ]
        : [],
      notes: deckAvailable
        ? 'Deck follows the supplied template and covers problem, product and demo.'
        : 'Deck text could not be extracted, so its contents have not been inferred.',
    },
    written: {
      problemSpecificity: 'high',
      targetUserSpecificity: 'medium',
      promiseIsCheckable: true,
      declaredMustHaveWorkflow:
        /DECLARED MUST-HAVE WORKFLOW:\s*[\s\S]{0,40}?\n([\s\S]{0,400}?)\n<<</.exec(user)?.[1]?.trim() ??
        'Create a record, edit it, and see it persist.',
      aiRoleDescribed: 'AI assists within the core workflow rather than as a separate chatbot.',
      notes: 'Written submission is specific and internally consistent.',
    },
    risks: ['Deck claims will need checking against observed behaviour.'],
  };
}

function testPlan(user: string): TestPlanOutput {
  const url = extractUrl(user);
  const loginRequired = user.includes('Login IS required');

  const steps: TestPlanOutput['steps'] = [
    { action: 'navigate', url, rationale: 'Load the product entry point.' },
    { action: 'screenshot', label: 'landing', rationale: 'Record the initial state.' },
  ];

  if (loginRequired) {
    steps.push(
      {
        action: 'fill',
        target: { role: 'textbox', name: 'Email' },
        value: 'OUTSKILL-JUDGE-CREDENTIAL-USERNAME',
        rationale: 'Executor substitutes the stored demo username.',
      },
      {
        action: 'fill',
        target: { role: 'textbox', name: 'Password' },
        value: 'OUTSKILL-JUDGE-CREDENTIAL-PASSWORD',
        rationale: 'Executor substitutes the stored demo password.',
      },
      { action: 'click', target: { role: 'button', name: 'Sign in' }, rationale: 'Authenticate.' },
    );
  }

  steps.push(
    { action: 'click', target: { role: 'button', name: 'Create' }, rationale: 'Begin the core workflow.' },
    {
      action: 'fill',
      target: { role: 'textbox', name: 'Title' },
      value: 'OUTSKILL-JUDGE-Item A1B2C3',
      rationale: 'Judge-prefixed so it can be cleaned up.',
    },
    { action: 'click', target: { role: 'button', name: 'Save' }, rationale: 'Complete creation.' },
    { action: 'assertText', text: 'OUTSKILL-JUDGE-Item A1B2C3', shouldExist: true, rationale: 'The record appears.' },
    { action: 'reload', rationale: 'Prove persistence rather than in-page state.' },
    {
      action: 'checkPersistence',
      expectText: 'OUTSKILL-JUDGE-Item A1B2C3',
      rationale: 'Data survived a reload.',
    },
    { action: 'click', target: { role: 'button', name: 'Edit' }, rationale: 'Exercise update.' },
    {
      action: 'fill',
      target: { role: 'textbox', name: 'Title' },
      value: 'OUTSKILL-JUDGE-Item A1B2C3 edited',
      rationale: 'Change a value.',
    },
    { action: 'click', target: { role: 'button', name: 'Save' }, rationale: 'Persist the update.' },
    { action: 'screenshot', label: 'after-edit', rationale: 'Record the updated state.' },
    { action: 'checkConsole', rationale: 'Detect runtime errors.' },
    { action: 'checkNetwork', rationale: 'Detect failed requests.' },
    { action: 'a11yScan', label: 'main', rationale: 'Accessibility baseline.' },
    {
      action: 'click',
      target: { role: 'button', name: 'Delete' },
      isCleanup: true,
      rationale: 'Remove the record the judge created.',
    },
    { action: 'cleanup', rationale: 'Best-effort removal of any remaining judge data.', isCleanup: true },
  );

  return {
    summary:
      'Loads the product, runs the declared core workflow, proves persistence across a reload, exercises update, checks console and network health, runs an accessibility scan, and cleans up.',
    steps,
    estimatedDurationMs: 180_000,
  };
}

function scoring(user: string): ScoringOutput {
  const videoLimited = user.includes('could not be analysed');
  const hasFailures = /failed|error|404|timed out/i.test(user);

  const scores = RUBRIC_CATEGORIES.map((category) => {
    const unit = seededUnit(user, category.key);
    const fraction = hasFailures ? 0.5 + unit * 0.2 : 0.68 + unit * 0.22;
    const rawScore = Math.round(category.maxPoints * fraction * 4) / 4;
    const limited = videoLimited && category.key === 'deck_demo';

    return {
      categoryKey: category.key,
      rawScore,
      confidence: limited ? 0.35 : hasFailures ? 0.72 : 0.85,
      rationale: `Scored from the recorded evidence for ${category.title.toLowerCase()}.`,
      supportingEvidence: [
        `Browser run recorded steps relevant to ${category.title.toLowerCase()}.`,
      ],
      contradictoryEvidence: hasFailures
        ? ['At least one step in the run failed, which limits what can be credited here.']
        : [],
      missingEvidence: limited
        ? ['The demo video could not be retrieved, so its clarity could not be assessed.']
        : [],
    };
  });

  return {
    scores,
    strengths: ['The declared core workflow was exercised end to end.'],
    weaknesses: hasFailures ? ['At least one step in the run did not complete.'] : [],
    risks: videoLimited ? ['Demo video evidence is missing; treat deck and demo scoring as provisional.'] : [],
    bugsFound: hasFailures
      ? [
          {
            description: 'A step in the declared workflow did not complete.',
            severity: 'medium' as const,
            evidence: 'Recorded as a failed step in the browser run.',
          },
        ]
      : [],
  };
}

function consistency() {
  return {
    agreesWithFirstPass: true,
    categoryAdjustments: [],
    notes: 'Second pass agrees with the first. Every score is supported by its cited evidence.',
  };
}

function feedback(user: string): FeedbackOutput {
  const productName = /Product:\s*(.+?)\s*\(/.exec(user)?.[1] ?? 'your product';
  const hasProblems = /PROBLEMS OBSERVED:\s*(?!None recorded)/.test(user);

  return {
    productSummary: `${productName} implements the workflow you committed to, and the core path was exercised from start to finish during testing.`,
    strengths: [
      'Your declared core workflow ran end to end during testing, which is the bar you were given and it was met.',
      'Data you created survived a page reload, so the product has a real backend rather than in-page state.',
      'The scope you declared matches what the product actually does — the parked features were genuinely parked, not half-built.',
    ],
    improvements: [
      {
        title: 'Handle the failure paths you have not seen yet',
        detail:
          'Everything worked during testing, so the error states were never exercised. Add a visible message and a retry to the slowest operation, so a failure does not leave a blank screen.',
        priority: 1,
      },
      {
        title: 'Fix the accessibility issues found in the scan',
        detail:
          'An automated scan found issues that affect people using assistive technology. Start with the most severe — they are usually the smallest fixes.',
        priority: 2,
      },
      {
        title: 'Give someone a reason to come back',
        detail:
          'The product completes one task well. A saved history or a way to resume previous work would turn a one-off into something used repeatedly.',
        priority: 3,
      },
    ],
    bugs: hasProblems
      ? [
          {
            description: 'A step in the core workflow did not complete during testing.',
            evidence: 'Recorded as a failed step in the automated run.',
          },
        ]
      : [],
    nextSevenDayPlan: [
      'Fix anything in the core workflow that did not complete.',
      'Add loading, success and error states to the slowest operation.',
      'Resolve the most severe accessibility issues.',
      'Watch three people who have never seen it try to use it.',
    ],
  };
}
