import { describe, expect, it } from 'vitest';
import {
  DECLARATION_KEYS,
  FINAL_SUBMIT_CONFIRMATION,
  evaluateCompleteness,
  declarationsStepSchema,
  finalSubmitSchema,
  groupNumberSchema,
  learningStepSchema,
  liveProductStepSchema,
  looksLikePdf,
  productStepSchema,
  teamStepSchema,
  validateDeckUpload,
} from './submission';

describe('group number validation', () => {
  it('accepts a whole number in range and coerces a numeric string', () => {
    expect(groupNumberSchema.parse(42)).toBe(42);
    expect(groupNumberSchema.parse('42')).toBe(42);
  });

  it('rejects the historical failure modes', () => {
    // An email typed into the group-number field was a real recurring problem.
    expect(groupNumberSchema.safeParse('lead@example.com').success).toBe(false);
    expect(groupNumberSchema.safeParse('Group 12').success).toBe(false);
    expect(groupNumberSchema.safeParse(0).success).toBe(false);
    expect(groupNumberSchema.safeParse(1000).success).toBe(false);
    expect(groupNumberSchema.safeParse(12.5).success).toBe(false);
  });
});

describe('team step', () => {
  const valid = {
    groupNumber: 12,
    leadName: 'Team Lead',
    leadEmail: 'lead@example.com',
    leadPhone: '+91 98765 43210',
    members: [{ fullName: 'Member One', contribution: 'Built the core screens.', isActive: true }],
  };

  it('accepts a complete team', () => {
    expect(teamStepSchema.safeParse(valid).success).toBe(true);
  });

  it('requires at least one member', () => {
    expect(teamStepSchema.safeParse({ ...valid, members: [] }).success).toBe(false);
  });

  it('accepts varied phone formatting but rejects nonsense', () => {
    for (const phone of ['+91 98765 43210', '9876543210', '(044) 2345-6789']) {
      expect(teamStepSchema.safeParse({ ...valid, leadPhone: phone }).success, phone).toBe(true);
    }
    expect(teamStepSchema.safeParse({ ...valid, leadPhone: 'call me' }).success).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(teamStepSchema.safeParse({ ...valid, leadEmail: 'not-an-email' }).success).toBe(false);
  });
});

describe('product step', () => {
  const valid = {
    ideaId: 'idea-1',
    productName: 'Trip Planner',
    primaryUser: 'A professional planning a short trip.',
    exactProblem: 'Plans end up scattered across chats and notes so nobody sees one clear plan.',
    oneSentencePromise: 'See your whole trip as one clear day-by-day plan.',
    briefDescription:
      'Create a trip, get days generated for the date range, add activities to each day, and view the full itinerary.',
    whyAiNecessary: 'AI turns an empty day into three concrete destination-relevant options.',
    differentiation: 'Existing tools are built around bookings; this is built around the day-by-day plan.',
    mustHaveWorkflow: 'Create a trip, generate days, add and edit activities, view the itinerary.',
    shouldHaveFeatures: ['Mark must-do', 'AI suggestions'],
    excludedFeatures: 'Map view and PDF export were left out.',
  };

  it('accepts a complete product step', () => {
    expect(productStepSchema.safeParse(valid).success).toBe(true);
  });

  it('allows at most two should-have features', () => {
    // Mirrors the MoSCoW rule the teams were taught.
    expect(
      productStepSchema.safeParse({ ...valid, shouldHaveFeatures: ['a', 'b', 'c'] }).success,
    ).toBe(false);
    expect(productStepSchema.safeParse({ ...valid, shouldHaveFeatures: [] }).success).toBe(true);
  });

  it('requires enough detail to be assessable', () => {
    expect(productStepSchema.safeParse({ ...valid, exactProblem: 'It is hard.' }).success).toBe(false);
    expect(productStepSchema.safeParse({ ...valid, mustHaveWorkflow: 'It works' }).success).toBe(false);
  });

  it('requires exactly one idea to be chosen', () => {
    expect(productStepSchema.safeParse({ ...valid, ideaId: '' }).success).toBe(false);
  });
});

describe('live product step', () => {
  const valid = {
    productUrl: 'https://my-product.example.com',
    loginRequired: false,
    coreTestSteps: [
      { action: 'Open the product', expectedResult: 'The trip list loads.' },
      { action: 'Create a trip', expectedResult: 'Days are generated.' },
    ],
    safeSampleInputs: 'Destination: Lisbon. Dates: 15–17 June 2030.',
    resetInstructions: 'Delete records prefixed OUTSKILL-JUDGE-.',
    knownLimitations: 'Suggestions can be slow on the first request.',
  };

  it('accepts a guest-accessible product', () => {
    expect(liveProductStepSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a non-HTTPS or private product URL', () => {
    expect(liveProductStepSchema.safeParse({ ...valid, productUrl: 'http://x.example.com' }).success).toBe(false);
    expect(liveProductStepSchema.safeParse({ ...valid, productUrl: 'https://localhost:3000' }).success).toBe(false);
  });

  it('requires credentials when the team says login is required', () => {
    const withoutCredentials = liveProductStepSchema.safeParse({ ...valid, loginRequired: true });
    expect(withoutCredentials.success).toBe(false);

    const withCredentials = liveProductStepSchema.safeParse({
      ...valid,
      loginRequired: true,
      demoUsername: 'reviewer@example.com',
      demoPassword: 'demo-password',
    });
    expect(withCredentials.success).toBe(true);
  });

  it('requires at least two core test steps', () => {
    expect(
      liveProductStepSchema.safeParse({ ...valid, coreTestSteps: [valid.coreTestSteps[0]] }).success,
    ).toBe(false);
  });
});

describe('artifact upload validation', () => {
  it('accepts a normal PDF', () => {
    expect(validateDeckUpload({ name: 'deck.pdf', type: 'application/pdf', size: 1_200_000 }).ok).toBe(true);
  });

  it('rejects the historical failure modes', () => {
    // A Loom link could not be uploaded here at all — the field is a file.
    expect(validateDeckUpload({ name: 'deck.pptx', type: 'application/vnd.ms-powerpoint', size: 1000 }).ok).toBe(false);
    expect(validateDeckUpload({ name: 'deck.pdf', type: 'text/html', size: 1000 }).ok).toBe(false);
    expect(validateDeckUpload({ name: 'deck.pdf', type: 'application/pdf', size: 0 }).ok).toBe(false);
    expect(validateDeckUpload({ name: 'deck.pdf', type: 'application/pdf', size: 40 * 1024 * 1024 }).ok).toBe(false);
  });

  it('checks PDF magic bytes, because a client MIME type is only a claim', () => {
    expect(looksLikePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
    expect(looksLikePdf(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // a zip / pptx
    expect(looksLikePdf(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]))).toBe(false); // html
  });
});

describe('learning step', () => {
  const bug = { description: 'Days were generated one short across a month boundary.', howFixed: 'Compared dates instead of counting days.' };
  const valid = {
    bugsFixed: [bug, bug, bug],
    deliberatelyExcluded: 'Map view was left out of scope.',
    majorTradeoff: 'We dropped the map so the edit flow could be finished properly.',
    day12ToDay13Changes: 'Day 13 added editing, deleting, and the AI suggestions panel.',
    mostImportantLearning: 'One flow done completely beat three flows half done.',
    nextSevenDayPlan: 'Fix contrast issues, add AI error handling, then test with five users.',
    builderStack: 'Bolt, Supabase, an LLM API.',
    apisUsed: 'LLM API',
    externalTemplates: 'Builder default template.',
  };

  it('requires exactly three bugs', () => {
    expect(learningStepSchema.safeParse(valid).success).toBe(true);
    expect(learningStepSchema.safeParse({ ...valid, bugsFixed: [bug, bug] }).success).toBe(false);
    expect(learningStepSchema.safeParse({ ...valid, bugsFixed: [bug, bug, bug, bug] }).success).toBe(false);
  });
});

describe('declarations', () => {
  it('requires every declaration to be affirmatively true', () => {
    const allTrue = Object.fromEntries(DECLARATION_KEYS.map((k) => [k, true]));
    expect(declarationsStepSchema.safeParse(allTrue).success).toBe(true);

    for (const key of DECLARATION_KEYS) {
      const oneFalse = { ...allTrue, [key]: false };
      expect(declarationsStepSchema.safeParse(oneFalse).success, key).toBe(false);
    }
  });

  it('covers all seven required declarations', () => {
    expect(DECLARATION_KEYS).toHaveLength(7);
    expect(DECLARATION_KEYS).toContain('judgeMayModifyDemoData');
    expect(DECLARATION_KEYS).toContain('urlsAvailableThroughJudging');
  });
});

describe('final submit confirmation', () => {
  it('requires the exact phrase, case-sensitively', () => {
    expect(finalSubmitSchema.safeParse({ confirmation: FINAL_SUBMIT_CONFIRMATION }).success).toBe(true);
    expect(finalSubmitSchema.safeParse({ confirmation: 'final submit' }).success).toBe(false);
    expect(finalSubmitSchema.safeParse({ confirmation: 'FINALSUBMIT' }).success).toBe(false);
    expect(finalSubmitSchema.safeParse({ confirmation: '' }).success).toBe(false);
  });
});

describe('completeness evaluation', () => {
  it('reports every incomplete step with field-level issues', () => {
    const result = evaluateCompleteness({ team: { groupNumber: 12 } });
    expect(result.complete).toBe(false);
    expect(result.steps).toHaveLength(6);
    expect(result.totalIssues).toBeGreaterThan(0);

    const teamStep = result.steps.find((s) => s.step === 'team');
    expect(teamStep?.complete).toBe(false);
    expect(teamStep?.issues.some((i) => i.path.includes('leadEmail'))).toBe(true);
  });

  it('reports an empty draft as incomplete without throwing', () => {
    const result = evaluateCompleteness({});
    expect(result.complete).toBe(false);
    expect(result.steps.every((s) => !s.complete)).toBe(true);
  });

  it('handles null and undefined drafts', () => {
    expect(evaluateCompleteness(null).complete).toBe(false);
    expect(evaluateCompleteness(undefined).complete).toBe(false);
  });
});
