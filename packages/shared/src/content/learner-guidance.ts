/**
 * What every question on the submission form actually means.
 *
 * One module, read by four surfaces: the form itself, the completed example,
 * the "what's missing" list, and the written guide. They cannot drift, because
 * there is only one copy of each sentence.
 *
 * The order of escalation matters and is deliberate. A question is first made
 * clear by *asking it better* — "Who is this product mainly for?" rather than
 * "Primary user". If that is not enough it gets one short helper line. If it is
 * still ambiguous it gets a worked example a learner can look at. Only then
 * does anything longer appear, and it appears on request. Guidance that is
 * always visible stops being read.
 *
 * The examples exist to explain the question, never to answer it. Nothing here
 * is ever written into a submission — see `guidance-integrity.test.ts`, which
 * proves that structurally rather than trusting this comment.
 */

import { SUBMISSION_STEPS, type SubmissionStepKey } from '../schemas/submission';

// --------------------------------------------------------------------------
// Fields
// --------------------------------------------------------------------------

export interface FieldGuide {
  /** The question, as a learner reads it. Plain English, ends in a question mark where it is one. */
  label: string;
  /** At most one short sentence under the label. Omitted when the label is already clear. */
  helper?: string;
  /**
   * The shortest answer that counts, in characters.
   *
   * Shown *before* anyone types, so nobody discovers a rule by failing it. The
   * number is asserted against the schema itself in `learner-guidance.test.ts`
   * — if a minimum changes and this does not, that test fails.
   */
  minChars?: number;
  /** Overrides the generated requirement line where the rule is not a length. */
  requirement?: string;
  /**
   * A short worked answer, shown only on request.
   *
   * Present only on questions that are genuinely open to misreading. A "See
   * example" on every field is the same as one on none.
   */
  example?: string;
  /** One line under the example, saying what a good answer contains. */
  exampleNote?: string;
  /**
   * The same question as a thing to do, for the "What's missing?" list.
   *
   * "Tell us why AI is useful" belongs in a to-do list; "Why is AI useful in
   * your product?" belongs above the box you type in. Written out rather than
   * derived, because turning a question into an instruction is a grammar
   * problem, and a rule that gets it wrong is worse than no rule.
   *
   * Absent on optional fields — they never appear in the list.
   */
  missing?: string;
}

/**
 * Keyed by the schema path, so a validation issue can find its own question
 * without a second lookup table to maintain. Array indices are stripped first
 * (`learning.bugsFixed.1.howFixed` → `learning.bugsFixed.howFixed`).
 */
export const FIELD_GUIDANCE: Record<string, FieldGuide> = {
  // ---- Team ----
  'team.groupNumber': {
    label: 'Your group number',
    helper: 'The number Outskill gave your team.',
    missing: 'Add your group number',
  },
  'team.leadName': { label: 'Team lead name', missing: "Add the team lead's name" },
  'team.leadEmail': {
    label: 'Team lead email',
    helper: 'We use this if we need to reach you about your submission.',
    missing: "Add the team lead's email",
  },
  'team.leadPhone': {
    label: 'Team lead phone',
    helper: 'Any format is fine — spaces, brackets and dashes all work.',
    missing: "Add the team lead's phone number",
  },
  'team.members': {
    label: 'Who worked on this project?',
    requirement: 'Add everyone who actively worked on it.',
    missing: 'Add at least one team member',
  },
  'team.members.fullName': { label: 'Name', missing: 'Add this member’s name' },
  'team.members.contribution': {
    label: 'What did they work on?',
    helper: 'One line is enough.',
    minChars: 10,
    example: 'Built the goal creation page and the progress form.',
    missing: 'Say what this member worked on',
  },

  // ---- Product idea ----
  'product.ideaId': {
    label: 'Which approved idea did you build?',
    helper: 'Pick one. You can only build from the ideas approved for your cohort.',
    requirement: 'Choose one idea.',
    missing: 'Choose which approved idea you built',
  },
  'product.productName': {
    label: 'What is your product called?',
    missing: 'Add your product name',
  },
  'product.primaryUser': {
    label: 'Who is this product mainly for?',
    helper: 'Be specific about the kind of person who would use it.',
    minChars: 10,
    example: 'People who want a simple way to track their fitness goals.',
    missing: 'Tell us who your product is for',
  },
  'product.exactProblem': {
    label: 'What exact problem are you solving for them?',
    helper: 'Describe one clear problem your user faces.',
    minChars: 30,
    example: 'People set fitness goals but often lose track of their daily progress.',
    exampleNote: 'A good answer tells us who has the problem, and what is difficult for them.',
    missing: 'Tell us what problem you are solving',
  },
  'product.oneSentencePromise': {
    label: 'Say what your product does in one sentence',
    helper: 'For [who], we built [what] so they can [do what].',
    minChars: 15,
    example:
      'For people with fitness goals, we built a simple tracker so they can see their progress every day.',
    missing: 'Sum up your product in one sentence',
  },
  'product.briefDescription': {
    label: 'What does the product do?',
    helper: 'Describe it the way you would to a friend.',
    minChars: 50,
    example:
      'Users create a fitness goal, add progress as they go, and see how close they are to finishing it.',
    missing: 'Describe what your product does',
  },
  'product.whyAiNecessary': {
    label: 'Why is AI useful in your product?',
    helper: 'What does AI do here that an ordinary app could not?',
    minChars: 30,
    example: "AI looks at the user's progress and gives simple suggestions on what they can do next.",
    missing: 'Tell us why AI is useful',
  },
  'product.differentiation': {
    label: 'What makes this different from a basic version?',
    helper: 'One thing you did that a quick, obvious build would not have.',
    minChars: 30,
    example:
      'Most trackers only show numbers. Ours explains what the numbers mean and suggests one next step.',
    missing: 'Tell us what makes it different from a basic version',
  },
  'product.mustHaveWorkflow': {
    label: 'What is the main thing a user should be able to do?',
    helper: 'Describe the most important start-to-finish flow.',
    minChars: 30,
    example: 'Create a goal, add progress, check how far along they are, and complete the goal.',
    exampleNote: 'This is the flow we will follow when we open your product, so keep it to one path.',
    missing: 'Describe the main thing a user can do',
  },
  'product.shouldHaveFeatures': {
    label: 'Anything else your product does?',
    helper: 'Optional, and at most two. Only list things that actually work.',
    requirement: 'Optional.',
  },
  'product.excludedFeatures': {
    label: 'What did you choose not to build?',
    helper: 'One thing you left out so you could finish something more important.',
    minChars: 10,
    example: 'We skipped reminders and notifications so the tracking itself worked properly.',
    missing: 'Tell us what you chose not to build',
  },

  // ---- Live product ----
  'live.productUrl': {
    label: 'Where can we open your product?',
    helper: 'A link starting with https:// that opens in a browser.',
    requirement: 'Not a Google Drive folder, and not a video link.',
    example: 'https://fitness-goal-tracker.vercel.app',
    missing: 'Add the link to your live product',
  },
  'live.loginRequired': {
    label: 'Does someone need to log in to use it?',
    requirement: 'Answer yes or no.',
    missing: 'Say whether your product needs a login',
  },
  'live.demoUsername': {
    label: 'Demo username',
    helper: 'Use a test account, never your own.',
    missing: 'Add a demo username we can log in with',
  },
  'live.demoPassword': {
    label: 'Demo password',
    helper: 'Stored encrypted, hidden from our dashboard, and never sent to an AI model.',
    missing: 'Add the demo password',
  },
  'live.loginInstructions': {
    label: 'Anything else we need to know to log in?',
    helper: 'Optional.',
    requirement: 'Optional.',
  },
  'live.coreTestSteps': {
    label: 'How should we test it?',
    helper: 'Walk us through your main flow, one action at a time.',
    requirement: 'Add at least 2 test steps.',
    missing: 'Add at least 2 test steps',
  },
  'live.coreTestSteps.action': {
    label: 'What should we do?',
    minChars: 5,
    example: 'Click "Add a goal".',
    missing: 'Say what we should do',
  },
  'live.coreTestSteps.expectedResult': {
    label: 'What should happen?',
    minChars: 5,
    example: 'A form opens asking for the goal name and target.',
    missing: 'Say what should happen',
  },
  'live.safeSampleInputs': {
    label: 'What can we safely type in?',
    helper: 'Example details that are fine for us to enter while testing.',
    minChars: 10,
    example: 'Goal name: Walk 10,000 steps a day. Target: 30 days. Progress: 8,000 steps.',
    missing: 'Give us sample details we can safely type in',
  },
  'live.resetInstructions': {
    label: 'How do we clean up afterwards?',
    helper: 'Tell us how to remove anything we create while testing.',
    minChars: 10,
    example: 'Open the goal and press Delete. Nothing else is saved.',
    missing: 'Tell us how to clean up after testing',
  },
  'live.knownLimitations': {
    label: "What doesn't work perfectly yet?",
    helper: "It's okay if something is unfinished. Tell us honestly.",
    minChars: 10,
    example: 'The mobile design still needs some polish and reminders are basic.',
    exampleNote: 'Saying this yourself is better than us finding it.',
    missing: 'Add one known limitation',
  },

  // ---- Demo and deck ----
  'artifacts.deckArtifactId': {
    label: 'Your pitch deck',
    requirement: 'Upload one PDF deck.',
    missing: 'Upload your pitch deck as a PDF',
  },
  'artifacts.demoVideoUrl': {
    label: 'Your demo video link',
    helper: 'A Loom, YouTube, Google Drive or Vimeo link.',
    requirement: 'Add your demo video link, and check anyone with the link can watch it.',
    missing: 'Add your demo video link',
  },
  'artifacts.demoUnderThreeMinutes': {
    label: 'Confirm your demo video is three minutes or shorter',
    requirement: 'Tick this box once your video is short enough.',
    missing: 'Confirm your demo video is three minutes or shorter',
  },

  // ---- Learning evidence ----
  'learning.bugsFixed': {
    label: 'Three things that went wrong, and how you fixed them',
    helper: 'Straight from the bug log in your workbook.',
    requirement: 'Fill in all three.',
    missing: 'Describe three bugs you found and fixed',
  },
  'learning.bugsFixed.description': {
    label: 'What went wrong?',
    minChars: 15,
    example: 'New goals were not showing immediately after saving.',
    missing: 'Say what went wrong',
  },
  'learning.bugsFixed.howFixed': {
    label: 'How did you fix it?',
    minChars: 10,
    example: 'We updated the page after saving so the new goal appears immediately.',
    missing: 'Say how you fixed it',
  },
  'learning.deliberatelyExcluded': {
    label: 'What did you decide not to build?',
    helper: 'One thing you left out on purpose, and why.',
    minChars: 15,
    example: 'We left out weekly email summaries because daily tracking mattered more.',
    missing: 'Tell us what you decided not to build',
  },
  'learning.majorTradeoff': {
    label: 'What did you choose not to build so you could focus on something more important?',
    helper: 'Tell us one decision you made because time was limited.',
    minChars: 20,
    example:
      'We spent our time on the progress screen instead of the design, because the numbers had to be right.',
    exampleNote: 'Trade-offs count in your favour. We are looking for a decision, not an apology.',
    missing: 'Tell us one decision you made because time was limited',
  },
  'learning.day12ToDay13Changes': {
    label: 'What changed between Day 12 and Day 13?',
    helper: 'Be specific about what you actually did on the second day.',
    minChars: 20,
    example:
      'On Day 13 we fixed the saving bug, added the progress bar, and rewrote the goal form so it was easier to use.',
    missing: 'Tell us what changed between Day 12 and Day 13',
  },
  'learning.mostImportantLearning': {
    label: 'What did you learn?',
    minChars: 20,
    example: 'A smaller workflow that works properly is better than many unfinished features.',
    missing: 'Tell us what you learned',
  },
  'learning.nextSevenDayPlan': {
    label: 'What would you do next?',
    helper: 'If you kept working on this for another week.',
    minChars: 20,
    example: 'Improve the mobile design, add better progress charts, and test with more users.',
    missing: 'Tell us what you would do next',
  },
  'learning.builderStack': {
    label: 'What did you build it with?',
    helper: 'The tools, platform or framework you used.',
    example: 'Lovable for the front end, Supabase for the database.',
    missing: 'Tell us what you built it with',
  },
  'learning.apisUsed': {
    label: 'Any APIs or services you used?',
    helper: 'Optional.',
    requirement: 'Optional.',
  },
  'learning.externalTemplates': {
    label: 'Any templates or starter code you used?',
    helper: 'Optional. Using a template is fine — not saying so is not.',
    requirement: 'Optional.',
  },
};

/**
 * The question for a schema path, with array indices removed.
 *
 * `live.coreTestSteps.0.action` and `learning.bugsFixed.2.howFixed` both need
 * the same guidance as their unindexed form.
 */
export function fieldGuide(path: string): FieldGuide | undefined {
  return FIELD_GUIDANCE[path] ?? FIELD_GUIDANCE[stripIndices(path)];
}

export function stripIndices(path: string): string {
  return path
    .split('.')
    .filter((part) => !/^\d+$/.test(part))
    .join('.');
}

/**
 * The requirement line shown under a question, before anyone types.
 *
 * Generated from `minChars` so the sentence and the rule cannot disagree. The
 * "usually" clause is calibrated to the length: 10 characters is a few words,
 * 50 is a couple of sentences, and telling someone "at least 50 characters"
 * without that translation just makes them count.
 */
export function requirementLine(guide: FieldGuide): string | undefined {
  if (guide.requirement) return guide.requirement;
  if (guide.minChars === undefined) return undefined;

  const shape =
    guide.minChars <= 10
      ? 'a few words is enough'
      : guide.minChars <= 20
        ? 'usually one sentence'
        : guide.minChars <= 40
          ? 'usually 1–2 sentences'
          : 'usually 2–3 sentences';

  return `Write at least ${guide.minChars} characters — ${shape}.`;
}

/**
 * What to call the nth entry of a repeated group.
 *
 * "How did you fix it?" is ambiguous when three bugs are missing one; "Bug 2 —
 * how did you fix it?" is not.
 */
export const REPEATED_GROUP_NOUN: Record<string, string> = {
  'team.members': 'Member',
  'live.coreTestSteps': 'Step',
  'learning.bugsFixed': 'Bug',
};

// --------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------

/** The six the learner sees. Declarations live inside Review, where they belong. */
export const LEARNER_STEPS = [
  'team',
  'product',
  'live',
  'artifacts',
  'learning',
  'review',
] as const;

export type LearnerStepKey = (typeof LEARNER_STEPS)[number];

export interface StepGuide {
  /** Short enough for a mobile step indicator. */
  label: string;
  /** One line at the top of the step, saying what it is for. */
  intro: string;
  /** What to have ready before starting — used by the guide and the checklist. */
  prepare?: string[];
}

export const STEP_GUIDANCE: Record<LearnerStepKey, StepGuide> = {
  team: {
    label: 'Team',
    intro: 'Tell us who built the project and what each person worked on.',
    prepare: ['Every active team member’s name', 'One line on what each person did'],
  },
  product: {
    label: 'Product idea',
    intro: 'Tell us who your product is for, what problem you are solving, and what you built.',
    prepare: [
      'Which approved idea you chose',
      'Who your product is for',
      'The one main thing a user can do',
    ],
  },
  live: {
    label: 'Live product',
    intro: 'Share your working product and tell us the main flow we should test.',
    prepare: [
      'A link that opens in a browser, not one that only works on your laptop',
      'A demo login, if your product needs one',
      'The steps we should follow, and what should happen at each one',
    ],
  },
  artifacts: {
    label: 'Demo and deck',
    intro: 'Upload your pitch deck and share your short demo video.',
    prepare: ['Your deck exported as a PDF', 'A demo video of three minutes or less'],
  },
  learning: {
    label: 'Learning evidence',
    intro:
      'Tell us what went wrong, what you fixed, what you learned, and what you would improve next.',
    prepare: ['Three bugs you found and fixed', 'What you would do with another week'],
  },
  review: {
    label: 'Review and submit',
    intro:
      "Check everything once. Final Submit locks your submission, so only use it when you're done.",
  },
};

/** Which learner step a schema step belongs to. Declarations surface under Review. */
export const SCHEMA_STEP_TO_LEARNER_STEP: Record<SubmissionStepKey, LearnerStepKey> = {
  team: 'team',
  product: 'product',
  live: 'live',
  artifacts: 'artifacts',
  learning: 'learning',
  declarations: 'review',
};

// --------------------------------------------------------------------------
// The first-run walkthrough
// --------------------------------------------------------------------------

export interface WalkthroughSlide {
  key: string;
  title: string;
  body: string;
}

/**
 * Two to three minutes, once.
 *
 * Six steps plus a welcome. Every line is one sentence, because this is read
 * standing up, on a phone, by someone who wants to start.
 */
export const WALKTHROUGH_SLIDES: WalkthroughSlide[] = [
  {
    key: 'welcome',
    title: 'Submit your hackathon project',
    body: 'There are 6 simple steps. Your work saves as you go, and you can come back before the deadline.',
  },
  ...LEARNER_STEPS.map((step) => ({
    key: step,
    title: STEP_GUIDANCE[step].label,
    body: STEP_GUIDANCE[step].intro,
  })),
];

/**
 * Where "has this learner seen the tour" is kept.
 *
 * The browser, not the submission. A tour flag written into the draft payload
 * would be a guidance feature mutating submitted work, which is exactly what
 * must not happen — and it would bump the version and race a teammate's save
 * for something that is not part of anyone's entry.
 */
export const WALKTHROUGH_SEEN_KEY = 'ohj.submission-tour.seen';

// --------------------------------------------------------------------------
// The checklist
// --------------------------------------------------------------------------

/** What to have ready before opening the form. Drives the help menu and the guide. */
export const SUBMISSION_CHECKLIST: { step: LearnerStepKey; items: string[] }[] = LEARNER_STEPS
  .filter((step) => (STEP_GUIDANCE[step].prepare?.length ?? 0) > 0)
  .map((step) => ({ step, items: STEP_GUIDANCE[step].prepare ?? [] }));

/** Mistakes that cost teams marks every cohort. Short, and about what to do instead. */
export const COMMON_MISTAKES: string[] = [
  'Sending a link that only works on your own laptop. Open it on your phone before you submit.',
  'A demo video nobody else can watch. Check the sharing setting in a private window.',
  'A deck that is a slide link rather than a PDF. Export it first — a link will not upload.',
  'Test steps that assume we already know your product. Write them for someone seeing it cold.',
  'Leaving the form to the last hour. It takes longer than teams expect, every single time.',
  'Pressing Final Submit before you are done. It locks your entry, and only Outskill can reopen it.',
];

export const FINAL_SUBMIT_EXPLANATION = {
  title: 'Before you submit',
  body: 'You can edit your answers until you use Final Submit. After that, your submission is locked.',
} as const;

/** Ordering guard: the learner steps must stay a superset of the schema steps. */
export const SCHEMA_STEPS_COVERED: SubmissionStepKey[] = [...SUBMISSION_STEPS];
