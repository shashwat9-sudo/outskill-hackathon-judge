import { describe, expect, it } from 'vitest';
import { validateFeedbackSafety } from './schemas';
import type { FeedbackOutput } from './schemas';

/**
 * What a participant may and may not learn from their feedback.
 *
 * They must never learn where they placed, what they were marked, or how they
 * compare to anyone else. That rule is not in question here — what was in
 * question was a check that enforced it by banning the words "point", "score",
 * "rank" and "confidence" outright.
 *
 * English did not cooperate. "Pain point", "at this point", "users can act with
 * confidence" are ordinary feedback prose leaking nothing, and any one of them
 * caused the entire report to be withheld. On the C13 run that discarded 43 of
 * 69 reports, silently; every production log line names the word "point".
 *
 * A control firing overwhelmingly on false positives protects nobody — it gets
 * the feature switched off, which is what happened, except nobody chose it and
 * nobody knew. So both halves are pinned below: every real leak still refused,
 * and the phrasing that used to be refused now allowed.
 */

const report = (over: Partial<FeedbackOutput> = {}): FeedbackOutput =>
  ({
    productSummary: 'A recipe app that saves what you cook.',
    strengths: ['The core flow works end to end.'],
    improvements: [{ title: 'Empty states', detail: 'Show something before the first recipe.', priority: 1 }],
    bugs: [{ description: 'Saving twice creates a duplicate.', evidence: 'step 4' }],
    nextSevenDayPlan: ['Add an empty state.'],
    ...over,
  }) as FeedbackOutput;

const allowed = (over: Partial<FeedbackOutput>) => validateFeedbackSafety(report(over)).ok;

describe('a real leak is still refused', () => {
  it.each([
    ['a mark out of 100', { productSummary: 'You achieved 61/100 overall.' }],
    ['a stated score', { productSummary: 'Your score was strong this round.' }],
    ['scoring with a number', { productSummary: 'You scored 61 on the core workflow.' }],
    ['a score phrase', { productSummary: 'A score of 12 for ease of use.' }],
    ['points awarded', { productSummary: 'You earned 12 points for the workflow.' }],
    ['out-of phrasing', { strengths: ['You got 12 out of 25 here.'] }],
    ['a placement', { productSummary: 'You ranked 7th in the cohort.' }],
    ['the rank noun', { productSummary: 'Your ranking improved.' }],
    ['ranked superlative', { strengths: ['You ranked highest on usefulness.'] }],
    ['the shortlist', { productSummary: 'You made the shortlist.' }],
    ['the top ten', { productSummary: 'You are in the top 10.' }],
    ['top four', { strengths: ['A likely top 4 finish.'] }],
    ['a winner', { productSummary: 'You are a winner of this hackathon.' }],
    ['disqualification', { bugs: [{ description: 'This could lead to disqualification.', evidence: 'x' }] }],
    ['judge confidence', { productSummary: 'Our confidence score here was low.' }],
    ['low-confidence', { improvements: [{ title: 'x', detail: 'Marked low-confidence.', priority: 1 }] }],
    ['other teams', { productSummary: 'Other teams did this better.' }],
    ['comparison', { strengths: ['Strong compared to the rest.'] }],
  ])('refuses %s', (_label, over) => {
    const result = validateFeedbackSafety(report(over as Partial<FeedbackOutput>));
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

describe('ordinary feedback prose is allowed', () => {
  it('allows "pain point", the exact word that withheld 43 reports', () => {
    /*
     * The precise production failure. Every withheld report on the C13 run
     * cited `"point"`, and none of them was leaking anything.
     */
    expect(allowed({ productSummary: 'The main pain point is the empty first screen.' })).toBe(true);
    expect(allowed({ strengths: ['At this point the flow is already usable.'] })).toBe(true);
    expect(allowed({ improvements: [{ title: 'Entry point', detail: 'Make the starting point obvious.', priority: 1 }] })).toBe(true);
  });

  it('allows confidence as a human quality', () => {
    expect(allowed({ strengths: ['Users can move through the flow with confidence.'] })).toBe(true);
  });

  it('allows a product that happens to rank or score things', () => {
    // A leaderboard app is not a leak about the hackathon.
    expect(allowed({ productSummary: 'It shows a ranked list of recipes by popularity.' })).toBe(true);
    expect(allowed({ strengths: ['The scoring rules inside your quiz are clear.'] })).toBe(true);
  });

  it('allows ordinary numbers that are not marks', () => {
    expect(allowed({ bugs: [{ description: 'Adding 3 items in a row loses the third.', evidence: 'x' }] })).toBe(true);
    expect(allowed({ nextSevenDayPlan: ['Ship 2 empty states and 1 error state.'] })).toBe(true);
  });

  it('allows a clean report', () => {
    expect(validateFeedbackSafety(report())).toEqual({ ok: true, problems: [] });
  });
});

describe('the problem message', () => {
  it('quotes what matched, so a withheld report can be understood', () => {
    const result = validateFeedbackSafety(report({ productSummary: 'You are in the top 10.' }));
    expect(result.problems[0]).toContain('top 10');
  });
});
