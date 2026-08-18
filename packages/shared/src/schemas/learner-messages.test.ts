import { describe, expect, it } from 'vitest';
import { evaluateCompleteness, humaniseIssue } from './submission';

/**
 * What a learner reads when something is missing.
 *
 * Zod's defaults are written for whoever wrote the schema. `Required` and
 * `Expected string, received null` say nothing about which answer is missing or
 * what to do, and a team seeing them at 23:50 has to guess.
 *
 * Found during the acceptance run, on a real submission form.
 */

describe('an empty submission', () => {
  const result = evaluateCompleteness({});
  const messages = result.steps.flatMap((s) => s.issues.map((i) => i.message));

  it('produces no raw schema text at all', () => {
    const raw = messages.filter((m) =>
      /^required$/i.test(m) || /^expected .+, received/i.test(m) || /^invalid input$/i.test(m),
    );
    expect(raw, `raw schema messages reached the learner: ${raw.join(' | ')}`).toEqual([]);
  });

  it('ends every message with a full stop, so it reads as a sentence', () => {
    const unpunctuated = messages.filter((m) => !/[.!?"]$/.test(m.trim()));
    expect(unpunctuated).toEqual([]);
  });

  it('names the thing that is missing', () => {
    // Not "This field is required" for everything.
    expect(messages.some((m) => /pitch deck/i.test(m))).toBe(true);
    expect(messages.some((m) => /product idea/i.test(m))).toBe(true);
    expect(messages.some((m) => /three important bugs/i.test(m))).toBe(true);
  });

  it('says what to do rather than what is wrong, where it can', () => {
    expect(messages).toContain('Upload your pitch deck as a PDF.');
    expect(messages).toContain('Choose one approved product idea.');
  });
});

describe('the catch-all', () => {
  it('humanises a bare Required using the field name', () => {
    expect(humaniseIssue(['live', 'safeSampleInputs'], 'Required')).toBe(
      'Safe sample inputs is required.',
    );
  });

  it('humanises a type complaint the same way', () => {
    expect(humaniseIssue(['team', 'leadEmail'], 'Expected string, received null')).toBe(
      'Lead email is required.',
    );
  });

  it('leaves a purpose-written message alone', () => {
    const written = 'Describe at least two steps so the judge can follow your core flow.';
    expect(humaniseIssue(['live', 'coreTestSteps'], written)).toBe(written);
  });

  it('keeps abbreviations readable', () => {
    expect(humaniseIssue(['live', 'productUrl'], 'Required')).toBe('Product URL is required.');
  });

  it('ignores array indexes, which mean nothing to a learner', () => {
    expect(humaniseIssue(['learning', 'bugsFixed', 0, 'description'], 'Required')).toBe(
      'Description is required.',
    );
  });

  it('falls back to something sayable when there is no field name', () => {
    expect(humaniseIssue([], 'Required')).toBe('This answer is required.');
  });
});
