/**
 * A completed submission, so a learner can see what "done" looks like.
 *
 * Entirely invented. Fitness Goal Tracker is not a team, has never been a team,
 * and none of this came from anyone's entry — a real submission used as a
 * teaching aid would be another team's work shown without their say-so, and it
 * would go stale the moment that cohort ended.
 *
 * Every answer that a field also offers inline is *the same string*, read from
 * `FIELD_GUIDANCE`. Two copies of "what a good answer looks like" would disagree
 * within a cohort, and the learner who noticed would be the one who trusted
 * neither. Where this file writes its own text, it is for a question that does
 * not warrant an inline example — a name, a URL, a list.
 *
 * It is data. Nothing here can be written into a submission; the example screen
 * renders it read-only and has no save path at all.
 */

import { FIELD_GUIDANCE } from './learner-guidance';

/** The shared answer for a field, or a loud failure. Silence would let the example rot. */
function shared(path: string): string {
  const example = FIELD_GUIDANCE[path]?.example;
  if (!example) {
    throw new Error(
      `completed-example expects FIELD_GUIDANCE["${path}"].example — the two must stay in step.`,
    );
  }
  return example;
}

export interface ExampleAnswer {
  /** The question, taken from the same guidance the real form shows. */
  path: string;
  answer: string;
}

export interface ExampleSection {
  step: string;
  title: string;
  answers: ExampleAnswer[];
}

export const EXAMPLE_PRODUCT_NAME = 'Fitness Goal Tracker';

export const EXAMPLE_BANNER = {
  label: 'Example only',
  body: 'Use this to understand what we are asking. Write your answers about your own project.',
} as const;

/**
 * The example team.
 *
 * Names chosen to be plainly fictional and group 0, which is not a number the
 * allocation ever issues.
 */
export const EXAMPLE_TEAM = {
  groupNumber: '0 (example)',
  leadName: 'Priya Raman',
  leadEmail: 'priya@example.com',
  leadPhone: '+91 90000 00000',
  members: [
    { fullName: 'Priya Raman', contribution: shared('team.members.contribution') },
    { fullName: 'Arjun Mehta', contribution: 'Set up the database and the login screen.' },
    { fullName: 'Sana Kapoor', contribution: 'Made the progress screen and fixed the mobile layout.' },
  ],
} as const;

export const EXAMPLE_TEST_STEPS = [
  {
    action: shared('live.coreTestSteps.action'),
    expectedResult: shared('live.coreTestSteps.expectedResult'),
  },
  {
    action: 'Type "Walk 10,000 steps a day" and set the target to 30 days, then press Save.',
    expectedResult: 'The goal appears in the list straight away, showing 0 of 30 days done.',
  },
  {
    action: 'Open the goal and add 8,000 steps for today.',
    expectedResult: 'The progress bar moves and the page shows one suggestion for tomorrow.',
  },
] as const;

export const EXAMPLE_BUGS = [
  {
    description: shared('learning.bugsFixed.description'),
    howFixed: shared('learning.bugsFixed.howFixed'),
  },
  {
    description: 'The progress bar went past 100% when someone logged more than their target.',
    howFixed: 'We capped the bar at 100% and showed the extra amount as a separate number.',
  },
  {
    description: 'On a phone, the Save button was hidden behind the keyboard.',
    howFixed: 'We moved the button above the keyboard so it is always reachable.',
  },
] as const;

/**
 * The example, section by section, in the order the real form asks.
 *
 * Rendered by the example page, and the source of the worked answers in the
 * written guide.
 */
export const COMPLETED_EXAMPLE: ExampleSection[] = [
  {
    step: 'team',
    title: 'Team',
    answers: [
      { path: 'team.leadName', answer: EXAMPLE_TEAM.leadName },
      { path: 'team.members.contribution', answer: shared('team.members.contribution') },
    ],
  },
  {
    step: 'product',
    title: 'Product idea',
    answers: [
      { path: 'product.productName', answer: EXAMPLE_PRODUCT_NAME },
      { path: 'product.primaryUser', answer: shared('product.primaryUser') },
      { path: 'product.exactProblem', answer: shared('product.exactProblem') },
      { path: 'product.oneSentencePromise', answer: shared('product.oneSentencePromise') },
      { path: 'product.briefDescription', answer: shared('product.briefDescription') },
      { path: 'product.whyAiNecessary', answer: shared('product.whyAiNecessary') },
      { path: 'product.differentiation', answer: shared('product.differentiation') },
      { path: 'product.mustHaveWorkflow', answer: shared('product.mustHaveWorkflow') },
      { path: 'product.excludedFeatures', answer: shared('product.excludedFeatures') },
    ],
  },
  {
    step: 'live',
    title: 'Live product',
    answers: [
      { path: 'live.productUrl', answer: shared('live.productUrl') },
      { path: 'live.safeSampleInputs', answer: shared('live.safeSampleInputs') },
      { path: 'live.resetInstructions', answer: shared('live.resetInstructions') },
      { path: 'live.knownLimitations', answer: shared('live.knownLimitations') },
    ],
  },
  {
    step: 'artifacts',
    title: 'Demo and deck',
    answers: [
      { path: 'artifacts.deckArtifactId', answer: 'fitness-goal-tracker-deck.pdf (2.1 MB)' },
      { path: 'artifacts.demoVideoUrl', answer: 'https://www.loom.com/share/example-demo-video' },
    ],
  },
  {
    step: 'learning',
    title: 'Learning evidence',
    answers: [
      { path: 'learning.deliberatelyExcluded', answer: shared('learning.deliberatelyExcluded') },
      { path: 'learning.majorTradeoff', answer: shared('learning.majorTradeoff') },
      { path: 'learning.day12ToDay13Changes', answer: shared('learning.day12ToDay13Changes') },
      { path: 'learning.mostImportantLearning', answer: shared('learning.mostImportantLearning') },
      { path: 'learning.nextSevenDayPlan', answer: shared('learning.nextSevenDayPlan') },
      { path: 'learning.builderStack', answer: shared('learning.builderStack') },
    ],
  },
];
