import { describe, expect, it } from 'vitest';
import {
  COMMON_MISTAKES,
  FIELD_GUIDANCE,
  FINAL_SUBMIT_EXPLANATION,
  LEARNER_STEPS,
  STEP_GUIDANCE,
  SUBMISSION_CHECKLIST,
  WALKTHROUGH_SLIDES,
  fieldGuide,
  requirementLine,
  stripIndices,
} from './learner-guidance';
import { evaluateCompleteness } from '../schemas/submission';

/**
 * The words a learner reads.
 *
 * Wording is the feature here, so it is tested like one. Three things have to
 * hold and none of them holds by itself:
 *
 *   - every rule stated to a learner is the rule the schema actually enforces;
 *   - every question that can block a submission has a plain-English question
 *     and a plain-English thing-to-do, so nothing falls through to Zod's own
 *     vocabulary;
 *   - nothing is written in the language of the people who built the form.
 *
 * The first is the one that rots quietly: a minimum changed in the schema and
 * not here leaves the form confidently telling teams the wrong number, and
 * nothing else in the system would notice.
 */

// --------------------------------------------------------------------------
// The stated rules are the enforced rules
// --------------------------------------------------------------------------

/** Array groups, and how many entries the schema wants before it stops complaining. */
const ARRAY_GROUPS: Record<string, number> = {
  'team.members': 1,
  'live.coreTestSteps': 2,
  'learning.bugsFixed': 3,
};

/** A draft with the right shape everywhere and content nowhere. */
function emptyDraft(): Record<string, Record<string, unknown>> {
  return {
    team: { members: [{}] },
    product: {},
    live: { coreTestSteps: [{}, {}] },
    artifacts: {},
    learning: { bugsFixed: [{}, {}, {}] },
    declarations: {},
  };
}

/**
 * Put `value` at a guidance path, expanding array groups to index 0.
 *
 * Returns the draft and the path the validator will report an issue at, which
 * carries the index the guidance path does not.
 */
function draftWith(path: string, value: string): { draft: Record<string, unknown>; issuePath: string } {
  const draft = emptyDraft();
  const [stepKey, ...rest] = path.split('.');
  const step = draft[stepKey!]!;

  // `learning.bugsFixed.description` → group "learning.bugsFixed", leaf "description".
  const groupPath = rest.length === 2 ? `${stepKey}.${rest[0]}` : null;

  if (groupPath && ARRAY_GROUPS[groupPath] !== undefined) {
    const rows = step[rest[0]!] as Record<string, unknown>[];
    rows[0] = { ...rows[0], [rest[1]!]: value };
    return { draft, issuePath: `${rest[0]}.0.${rest[1]}` };
  }

  step[rest[0]!] = value;
  return { draft, issuePath: rest[0]! };
}

/** Whether the validator complains about this exact field. */
function complainsAbout(
  draft: Record<string, unknown>,
  stepKey: string,
  issuePath: string,
): boolean {
  const summary = evaluateCompleteness(draft).steps.find((s) => s.step === stepKey);
  return (summary?.issues ?? []).some((issue) => issue.path === issuePath);
}

describe('every stated minimum is the enforced minimum', () => {
  const withMinimums = Object.entries(FIELD_GUIDANCE).filter(([, guide]) => guide.minChars);

  it('covers a meaningful part of the form', () => {
    expect(withMinimums.length).toBeGreaterThan(15);
  });

  for (const [path, guide] of withMinimums) {
    const min = guide.minChars!;
    const stepKey = path.split('.')[0]!;

    it(`${path}: ${min} characters is accepted`, () => {
      const { draft, issuePath } = draftWith(path, 'x'.repeat(min));
      expect(
        complainsAbout(draft, stepKey, issuePath),
        `the form promises ${min} characters is enough, and the schema disagreed`,
      ).toBe(false);
    });

    it(`${path}: ${min - 1} characters is refused`, () => {
      const { draft, issuePath } = draftWith(path, 'x'.repeat(min - 1));
      expect(
        complainsAbout(draft, stepKey, issuePath),
        `the form states a minimum of ${min}, and the schema accepted ${min - 1}`,
      ).toBe(true);
    });
  }
});

describe('the requirement line', () => {
  it('states the number and translates it', () => {
    expect(requirementLine({ label: 'x', minChars: 30 })).toBe(
      'Write at least 30 characters — usually 1–2 sentences.',
    );
    expect(requirementLine({ label: 'x', minChars: 10 })).toBe(
      'Write at least 10 characters — a few words is enough.',
    );
    expect(requirementLine({ label: 'x', minChars: 50 })).toBe(
      'Write at least 50 characters — usually 2–3 sentences.',
    );
  });

  it('prefers an explicit rule where the rule is not a length', () => {
    expect(requirementLine(FIELD_GUIDANCE['live.coreTestSteps']!)).toBe('Add at least 2 test steps.');
    expect(requirementLine(FIELD_GUIDANCE['artifacts.deckArtifactId']!)).toBe('Upload one PDF deck.');
    expect(requirementLine(FIELD_GUIDANCE['artifacts.demoVideoUrl']!)).toContain(
      'Add your demo video link',
    );
  });

  it('says nothing where there is nothing to say', () => {
    expect(requirementLine({ label: 'Team lead name' })).toBeUndefined();
  });

  it('never leaks a schema word', () => {
    for (const guide of Object.values(FIELD_GUIDANCE)) {
      const line = requirementLine(guide);
      if (!line) continue;
      expect(line).not.toMatch(/required\b|invalid|z\.|string|schema|refine|parse/i);
    }
  });
});

// --------------------------------------------------------------------------
// Nothing falls through to the schema's own vocabulary
// --------------------------------------------------------------------------

describe('every question that can block a submission has words of its own', () => {
  /** Everything the validator complains about when nothing has been filled in. */
  const blocking = evaluateCompleteness({}).steps.flatMap((step) =>
    step.issues.map((issue) => ({
      step: step.step,
      path: issue.path ? `${step.step}.${issue.path}` : step.step,
    })),
  );

  it('finds a real set of blocking fields', () => {
    expect(blocking.length).toBeGreaterThan(25);
  });

  it('has a plain-English question for each one', () => {
    const orphans = blocking
      // Declarations are their own list, phrased in DECLARATION_MISSING.
      .filter((entry) => entry.step !== 'declarations')
      .filter((entry) => !fieldGuide(entry.path))
      .map((entry) => entry.path);

    expect(orphans, 'these fields would fall back to schema wording').toEqual([]);
  });

  it('has a thing-to-do for each one', () => {
    const orphans = blocking
      .filter((entry) => entry.step !== 'declarations')
      .filter((entry) => !fieldGuide(entry.path)?.missing)
      .map((entry) => entry.path);

    expect(orphans, 'these would appear in "What’s missing?" as a question, not a task').toEqual(
      [],
    );
  });
});

describe('the wording is a learner’s, not ours', () => {
  const everything = Object.entries(FIELD_GUIDANCE);

  it('has replaced the labels that read as field names', () => {
    // The exact wording this feature exists to remove.
    const banished = [
      'Primary user',
      'Exact problem',
      'Must-have workflow',
      'Known limitations',
      'Major trade-off',
      'Deliberately excluded',
      'Core test scenario',
      'Safe sample inputs',
      'Artifact',
      'Payload',
      'Field',
    ];
    for (const [path, guide] of everything) {
      for (const phrase of banished) {
        expect(guide.label, `${path} still reads as a field name`).not.toContain(phrase);
      }
    }
  });

  it('asks questions rather than naming things, wherever it is asking one', () => {
    const questions = everything.filter(([, guide]) => guide.label.endsWith('?'));
    expect(questions.length).toBeGreaterThan(20);
  });

  it('keeps every label short enough to read at a glance', () => {
    for (const [path, guide] of everything) {
      expect(guide.label.length, `${path} has a long label`).toBeLessThanOrEqual(90);
    }
  });

  it('keeps helpers to one sentence', () => {
    for (const [path, guide] of everything) {
      if (!guide.helper) continue;
      expect(guide.helper.length, `${path} has a long helper`).toBeLessThanOrEqual(120);
      const sentences = guide.helper.split(/(?<=[.?!])\s+/).filter(Boolean);
      expect(sentences.length, `${path} has a multi-sentence helper`).toBeLessThanOrEqual(2);
    }
  });

  it('uses no technical language anywhere a learner reads', () => {
    const jargon = [
      'artifact',
      'payload',
      'schema',
      'validation',
      'endpoint',
      'idempotent',
      'rubric',
      'assessment',
      'evidence',
      'confidence',
      'shortlist',
      'score',
    ];
    for (const [path, guide] of everything) {
      const text = [guide.label, guide.helper, guide.requirement, guide.example, guide.exampleNote, guide.missing]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      for (const word of jargon) {
        expect(text, `${path} used "${word}"`).not.toContain(word);
      }
    }
  });
});

describe('the examples explain, and stay out of the way', () => {
  const withExamples = Object.entries(FIELD_GUIDANCE).filter(([, guide]) => guide.example);

  it('appear only where a question is genuinely open to misreading', () => {
    // Not on every field. An example everywhere is an example nowhere.
    expect(withExamples.length).toBeGreaterThan(15);
    expect(withExamples.length).toBeLessThan(Object.keys(FIELD_GUIDANCE).length);

    for (const bare of ['team.leadName', 'team.leadEmail', 'product.productName']) {
      expect(FIELD_GUIDANCE[bare]?.example, `${bare} does not need an example`).toBeUndefined();
    }
  });

  it('sound like a learner wrote them', () => {
    for (const [path, guide] of withExamples) {
      const example = guide.example!;
      expect(example.length, `${path}'s example is long`).toBeLessThanOrEqual(130);

      // Corporate copy, which is exactly what these must not become.
      for (const phrase of [
        'leverage',
        'seamless',
        'synerg',
        'cutting-edge',
        'revolutionary',
        'best-in-class',
        'end-to-end solution',
        'empower',
        'holistic',
      ]) {
        expect(example.toLowerCase(), `${path}'s example reads as marketing`).not.toContain(phrase);
      }
    }
  });

  it('are long enough to be valid answers, so nobody is shown something we would reject', () => {
    for (const [path, guide] of withExamples) {
      if (!guide.minChars) continue;
      expect(
        guide.example!.length,
        `${path}'s example is shorter than the minimum it sits next to`,
      ).toBeGreaterThanOrEqual(guide.minChars);
    }
  });

  it('all describe the same made-up project', () => {
    // One coherent example beats a dozen unrelated ones — a learner reading
    // three fields in a row should be watching one team think.
    const joined = withExamples.map(([, guide]) => guide.example!).join(' ').toLowerCase();
    expect(joined).toContain('goal');
    expect(joined).toContain('progress');
  });
});

// --------------------------------------------------------------------------
// The tour and the checklist
// --------------------------------------------------------------------------

describe('the walkthrough', () => {
  it('is a welcome plus the six steps, and nothing else', () => {
    expect(WALKTHROUGH_SLIDES).toHaveLength(7);
    expect(WALKTHROUGH_SLIDES[0]!.key).toBe('welcome');
    expect(WALKTHROUGH_SLIDES.slice(1).map((slide) => slide.key)).toEqual([...LEARNER_STEPS]);
  });

  it('opens by saying how many steps there are and that work is saved', () => {
    const welcome = WALKTHROUGH_SLIDES[0]!;
    expect(welcome.title).toBe('Submit your hackathon project');
    expect(welcome.body).toContain('6 simple steps');
    expect(welcome.body).toContain('saves as you go');
  });

  it('warns that Final Submit locks, on the last card', () => {
    const last = WALKTHROUGH_SLIDES[WALKTHROUGH_SLIDES.length - 1]!;
    expect(last.title).toBe('Review and submit');
    expect(last.body).toContain('locks your submission');
  });

  it('is short enough to read standing up', () => {
    for (const slide of WALKTHROUGH_SLIDES) {
      expect(slide.body.length, `${slide.key} is long for a tour card`).toBeLessThanOrEqual(140);
      expect(slide.title.length).toBeLessThanOrEqual(40);
    }
    // Roughly 150 words at a comfortable reading pace is well under two minutes.
    const words = WALKTHROUGH_SLIDES.map((s) => `${s.title} ${s.body}`).join(' ').split(/\s+/).length;
    expect(words).toBeLessThan(200);
  });

  it('says the same thing the step itself says', () => {
    for (const step of LEARNER_STEPS) {
      const slide = WALKTHROUGH_SLIDES.find((s) => s.key === step)!;
      expect(slide.body).toBe(STEP_GUIDANCE[step].intro);
      expect(slide.title).toBe(STEP_GUIDANCE[step].label);
    }
  });
});

describe('the checklist and the mistakes', () => {
  it('covers the five steps that need preparation', () => {
    expect(SUBMISSION_CHECKLIST.map((entry) => entry.step)).toEqual([
      'team',
      'product',
      'live',
      'artifacts',
      'learning',
    ]);
    for (const entry of SUBMISSION_CHECKLIST) {
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });

  it('names mistakes and what to do instead, not just the mistake', () => {
    expect(COMMON_MISTAKES.length).toBeGreaterThanOrEqual(5);
    for (const mistake of COMMON_MISTAKES) {
      // Two sentences: what goes wrong, then the fix.
      expect(mistake.split(/(?<=[.?!])\s+/).filter(Boolean).length, mistake).toBeGreaterThanOrEqual(2);
    }
  });

  it('explains Final Submit in the words the form uses', () => {
    expect(FINAL_SUBMIT_EXPLANATION.title).toBe('Before you submit');
    expect(FINAL_SUBMIT_EXPLANATION.body).toContain('until you use Final Submit');
    expect(FINAL_SUBMIT_EXPLANATION.body).toContain('locked');
  });
});

describe('path handling', () => {
  it('strips array indices', () => {
    expect(stripIndices('learning.bugsFixed.2.howFixed')).toBe('learning.bugsFixed.howFixed');
    expect(stripIndices('product.primaryUser')).toBe('product.primaryUser');
  });

  it('finds the guidance for an indexed field', () => {
    expect(fieldGuide('learning.bugsFixed.1.description')?.label).toBe('What went wrong?');
    expect(fieldGuide('live.coreTestSteps.0.action')?.label).toBe('What should we do?');
    expect(fieldGuide('team.members.4.contribution')?.label).toBe('What did they work on?');
  });

  it('returns nothing for a field it has never heard of', () => {
    expect(fieldGuide('product.somethingNew')).toBeUndefined();
  });
});

describe('the six steps', () => {
  it('explain themselves in one sentence each', () => {
    for (const step of LEARNER_STEPS) {
      const guide = STEP_GUIDANCE[step];
      expect(guide.intro.length, `${step} intro is long`).toBeLessThanOrEqual(140);
      expect(guide.label.length).toBeLessThanOrEqual(20);
    }
  });

  it('cover every schema step', () => {
    // The learner's six are the schema's six with declarations folded into
    // Review. A schema step with nowhere to live would be unreachable.
    expect(LEARNER_STEPS).toContain('review');
    expect(LEARNER_STEPS).toHaveLength(6);
  });
});
