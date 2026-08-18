import { describe, expect, it } from 'vitest';
import {
  DECLARATION_MISSING,
  collectMissingItems,
  fieldDomId,
  missingSummaryLabel,
  stepMissingItems,
} from './missing-items';
import { DECLARATION_KEYS, evaluateCompleteness } from '../schemas/submission';
import { FIELD_GUIDANCE } from '../content/learner-guidance';

/**
 * "What's missing?" has to be right, and it has to be readable.
 *
 * Right, because a learner who fixes everything on the list and still cannot
 * submit will stop trusting the list — and then the only remaining way to find
 * out what is wrong is to ask someone at Outskill, which is the thing this
 * whole feature exists to avoid.
 *
 * Readable, because the source of every item is a Zod issue, and Zod's issues
 * are written for whoever wrote the schema.
 */

/** A draft with the array shapes present and nothing filled in. */
function emptyDraft() {
  return {
    team: { members: [{}] },
    product: {},
    live: { coreTestSteps: [{}, {}] },
    artifacts: {},
    learning: { bugsFixed: [{}, {}, {}] },
    declarations: {},
  };
}

const missingFor = (draft: unknown) => collectMissingItems(evaluateCompleteness(draft));

describe('accuracy', () => {
  it('reports nothing when a step is complete', () => {
    const complete = evaluateCompleteness({}).steps.find((s) => s.step === 'team')!;
    expect(stepMissingItems({ ...complete, complete: true, issues: [] })).toEqual([]);
  });

  it('accounts for every blocking field on an empty draft', () => {
    const completeness = evaluateCompleteness(emptyDraft());
    const missing = missingFor(emptyDraft());

    // One item per distinct field, so the count can be lower than the raw issue
    // count but never higher — and never zero while the form is incomplete.
    expect(completeness.complete).toBe(false);
    expect(missing.total).toBeGreaterThan(20);
    expect(missing.total).toBeLessThanOrEqual(completeness.totalIssues);
  });

  it('empties out exactly as fields are filled in', () => {
    const draft = emptyDraft();
    const before = missingFor(draft).byStep.product.length;

    (draft.product as Record<string, unknown>).primaryUser =
      'People who want a simple way to track their fitness goals.';

    const after = missingFor(draft).byStep.product;
    expect(after.length).toBe(before - 1);
    expect(after.some((item) => item.path === 'product.primaryUser')).toBe(false);
  });

  it('never lists one field twice, however many rules it breaks', () => {
    // A single typed character fails both "required" and "too short" at once.
    const draft = emptyDraft();
    (draft.product as Record<string, unknown>).exactProblem = 'x';

    const items = missingFor(draft).items.filter((item) => item.path === 'product.exactProblem');
    expect(items).toHaveLength(1);
  });

  it('says nothing is missing once everything is answered', () => {
    const missing = missingFor(FULL_DRAFT);
    expect(evaluateCompleteness(FULL_DRAFT).complete).toBe(true);
    expect(missing.total).toBe(0);
    expect(missing.items).toEqual([]);
  });

  it('groups items under the step that owns them', () => {
    const missing = missingFor(emptyDraft());

    for (const item of missing.items) {
      expect(missing.byStep[item.step]).toContain(item);
    }
    // Declarations belong to Review, where the learner actually ticks them.
    expect(missing.byStep.review.length).toBe(DECLARATION_KEYS.length);
    expect(missing.byStep.team.length).toBeGreaterThan(0);
    expect(missing.byStep.artifacts.length).toBeGreaterThan(0);
  });

  it('adds up: the per-step counts are the total', () => {
    const missing = missingFor(emptyDraft());
    const summed = Object.values(missing.byStep).reduce((total, items) => total + items.length, 0);
    expect(summed).toBe(missing.total);
  });
});

describe('readability', () => {
  it('gives every item something to do, in plain English', () => {
    for (const item of missingFor(emptyDraft()).items) {
      expect(item.text.length, item.path).toBeGreaterThan(3);
      expect(item.text[0], `${item.path} does not start with a capital`).toBe(
        item.text[0]!.toUpperCase(),
      );
    }
  });

  it('never shows a learner the schema', () => {
    for (const item of missingFor(emptyDraft()).items) {
      const text = `${item.text} ${item.detail ?? ''}`;
      for (const leak of [
        'Required',
        'Expected',
        'received',
        'invalid_type',
        'Invalid input',
        'ZodError',
        'undefined',
        'null',
        'string',
        'boolean',
        'array',
        'literal',
      ]) {
        expect(text, `${item.path} leaked "${leak}"`).not.toContain(leak);
      }
      // And no dotted paths in anything a learner reads.
      expect(text, `${item.path} showed a field path`).not.toMatch(/[a-z]+\.[a-zA-Z]+/);
    }
  });

  it('names which one, inside a repeated group', () => {
    const draft = emptyDraft();
    const items = missingFor(draft).items;

    const bugTwo = items.find((item) => item.path === 'learning.bugsFixed.1.howFixed');
    expect(bugTwo?.text).toBe('Bug 2 — say how you fixed it');

    const stepOne = items.find((item) => item.path === 'live.coreTestSteps.0.action');
    expect(stepOne?.text).toBe('Step 1 — say what we should do');

    const member = items.find((item) => item.path === 'team.members.0.fullName');
    expect(member?.text).toBe('Member 1 — add this member’s name');
  });

  it('states the rule alongside, where there is one worth stating', () => {
    const items = missingFor(emptyDraft()).items;
    const problem = items.find((item) => item.path === 'product.exactProblem');
    expect(problem?.detail).toBe('Write at least 30 characters — usually 1–2 sentences.');

    const deck = items.find((item) => item.path === 'artifacts.deckArtifactId');
    expect(deck?.detail).toBe('Upload one PDF deck.');
  });

  it('never states "Optional." as a reason something is blocking', () => {
    for (const item of missingFor(emptyDraft()).items) {
      expect(item.detail, item.path).not.toBe('Optional.');
    }
  });

  it('uses the same words as the question the learner will land on', () => {
    for (const item of missingFor(emptyDraft()).items) {
      const guide = FIELD_GUIDANCE[item.path.split('.').filter((p) => !/^\d+$/.test(p)).join('.')];
      if (!guide?.missing) continue;
      expect(item.text.toLowerCase()).toContain(guide.missing.toLowerCase().slice(0, 12));
    }
  });
});

describe('declarations', () => {
  it('names each one as a thing to confirm, not as legal text', () => {
    const items = missingFor(emptyDraft()).byStep.review;
    expect(items).toHaveLength(7);

    for (const item of items) {
      expect(item.text.length, `${item.path} reads as a paragraph`).toBeLessThanOrEqual(80);
      expect(Object.values(DECLARATION_MISSING)).toContain(item.text);
    }
  });

  it('has a phrase for every declaration the schema requires', () => {
    for (const key of DECLARATION_KEYS) {
      expect(DECLARATION_MISSING[key], `${key} has no learner-facing phrase`).toBeTruthy();
    }
    expect(Object.keys(DECLARATION_MISSING).sort()).toEqual([...DECLARATION_KEYS].sort());
  });

  it('drops one as each is ticked', () => {
    const draft = emptyDraft();
    (draft.declarations as Record<string, unknown>).ownedByTeam = true;
    const items = missingFor(draft).byStep.review;
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.text)).not.toContain(DECLARATION_MISSING.ownedByTeam);
  });
});

describe('where an item points', () => {
  it('derives the field id from the path', () => {
    expect(fieldDomId('product.primaryUser')).toBe('primaryUser');
    expect(fieldDomId('learning.bugsFixed.2.howFixed')).toBe('bugsFixed-2-howFixed');
    expect(fieldDomId('live.coreTestSteps.0.action')).toBe('coreTestSteps-0-action');
    expect(fieldDomId('declarations.ownedByTeam')).toBe('ownedByTeam');
  });

  it('produces an id for every item, and never an empty one', () => {
    for (const item of missingFor(emptyDraft()).items) {
      expect(item.fieldId, item.path).toBeTruthy();
      expect(item.fieldId, item.path).not.toContain('.');
    }
  });

  it('gives distinct ids to distinct fields', () => {
    const items = missingFor(emptyDraft()).items;
    const ids = items.map((item) => item.fieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the count', () => {
  it('reads naturally at one, and at more than one', () => {
    expect(missingSummaryLabel(0)).toBe('Nothing left');
    expect(missingSummaryLabel(1)).toBe('1 thing left');
    expect(missingSummaryLabel(2)).toBe('2 things left');
    expect(missingSummaryLabel(11)).toBe('11 things left');
  });
});

// --------------------------------------------------------------------------

/** A submission with every answer present — the only state that must produce zero items. */
const FULL_DRAFT = {
  team: {
    groupNumber: 12,
    leadName: 'Priya Raman',
    leadEmail: 'priya@example.com',
    leadPhone: '+91 90000 00000',
    members: [{ fullName: 'Priya Raman', contribution: 'Built the goal creation page.', isActive: true }],
  },
  product: {
    ideaId: 'idea-1',
    productName: 'Fitness Goal Tracker',
    primaryUser: 'People who want a simple way to track their fitness goals.',
    exactProblem: 'People set fitness goals but often lose track of their daily progress.',
    oneSentencePromise: 'For people with fitness goals, we built a simple tracker.',
    briefDescription:
      'Users create a fitness goal, add progress as they go, and see how close they are to finishing it.',
    whyAiNecessary: "AI looks at the user's progress and suggests what they can do next.",
    differentiation: 'Most trackers only show numbers. Ours explains what the numbers mean.',
    mustHaveWorkflow: 'Create a goal, add progress, check how far along they are, and finish it.',
    shouldHaveFeatures: [],
    excludedFeatures: 'We skipped reminders so the tracking itself worked properly.',
  },
  live: {
    productUrl: 'https://fitness-goal-tracker.example.com',
    loginRequired: false,
    coreTestSteps: [
      { action: 'Click "Add a goal".', expectedResult: 'A form opens asking for the goal name.' },
      { action: 'Save the goal.', expectedResult: 'The goal appears in the list straight away.' },
    ],
    safeSampleInputs: 'Goal name: Walk 10,000 steps a day. Target: 30 days.',
    resetInstructions: 'Open the goal and press Delete. Nothing else is saved.',
    knownLimitations: 'The mobile design still needs some polish.',
  },
  artifacts: {
    deckArtifactId: 'artifact-deck-1',
    demoVideoUrl: 'https://www.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    demoUnderThreeMinutes: true,
    screenshotArtifactIds: [],
  },
  learning: {
    bugsFixed: [
      {
        description: 'New goals were not showing immediately after saving.',
        howFixed: 'We updated the page after saving so the goal appears.',
      },
      {
        description: 'The progress bar went past 100% when someone logged extra.',
        howFixed: 'We capped the bar at 100% and showed the extra separately.',
      },
      {
        description: 'On a phone, the Save button was hidden behind the keyboard.',
        howFixed: 'We moved the button above the keyboard.',
      },
    ],
    deliberatelyExcluded: 'We left out weekly email summaries because daily tracking mattered more.',
    majorTradeoff: 'We spent our time on the progress screen instead of the design.',
    day12ToDay13Changes: 'On Day 13 we fixed the saving bug and added the progress bar.',
    mostImportantLearning: 'A smaller workflow that works properly beats many unfinished ones.',
    nextSevenDayPlan: 'Improve the mobile design and add better progress charts.',
    builderStack: 'Lovable and Supabase',
    apisUsed: '',
    externalTemplates: '',
  },
  declarations: Object.fromEntries(DECLARATION_KEYS.map((key) => [key, true])),
};
