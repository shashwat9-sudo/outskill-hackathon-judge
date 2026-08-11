import { describe, expect, it } from 'vitest';
import {
  RUBRIC_CATEGORIES,
  RUBRIC_CATEGORY_KEYS,
  RUBRIC_TOTAL_POINTS,
  clampScore,
  getPublicRubric,
  getRubricCategory,
  isCompleteScoreSet,
  roundToQuarter,
  totalScore,
  weightedScore,
} from './index';

describe('rubric integrity', () => {
  it('sums to exactly 100 points', () => {
    const sum = RUBRIC_CATEGORIES.reduce((acc, c) => acc + c.maxPoints, 0);
    expect(sum).toBe(100);
    expect(sum).toBe(RUBRIC_TOTAL_POINTS);
  });

  it('matches the weights fixed by the event rules', () => {
    const weights = Object.fromEntries(RUBRIC_CATEGORIES.map((c) => [c.key, c.maxPoints]));
    expect(weights).toEqual({
      problem_clarity: 15,
      core_workflow: 25,
      stability: 15,
      ai_usefulness: 15,
      learning_execution: 10,
      ux_accessibility: 10,
      practical_potential: 5,
      deck_demo: 5,
    });
  });

  it('has exactly eight categories with unique keys and display orders', () => {
    expect(RUBRIC_CATEGORIES).toHaveLength(8);
    expect(new Set(RUBRIC_CATEGORIES.map((c) => c.key)).size).toBe(8);
    expect([...RUBRIC_CATEGORIES].map((c) => c.displayOrder).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('declares at least one evidence source per category', () => {
    for (const category of RUBRIC_CATEGORIES) {
      expect(category.evidenceSources.length).toBeGreaterThan(0);
    }
  });
});

describe('public rubric projection', () => {
  it('never carries private scoring guidance', () => {
    const publicRubric = getPublicRubric();
    const serialised = JSON.stringify(publicRubric);

    for (const category of RUBRIC_CATEGORIES) {
      expect(serialised).not.toContain(category.privateGuidance);
    }
    for (const entry of publicRubric) {
      expect(entry).not.toHaveProperty('privateGuidance');
      expect(entry).not.toHaveProperty('evidenceSources');
    }
  });

  it('exposes every category and weight participants are entitled to see', () => {
    const publicRubric = getPublicRubric();
    expect(publicRubric).toHaveLength(8);
    expect(publicRubric.reduce((sum, c) => sum + c.maxPoints, 0)).toBe(100);
    expect(publicRubric.map((c) => c.key)).toEqual([...RUBRIC_CATEGORY_KEYS]);
  });
});

describe('score arithmetic', () => {
  it('clamps to the category maximum and to zero', () => {
    expect(clampScore(30, 25)).toBe(25);
    expect(clampScore(-4, 25)).toBe(0);
    expect(clampScore(12.5, 25)).toBe(12.5);
    expect(clampScore(Number.NaN, 25)).toBe(0);
  });

  it('rounds to the nearest quarter point', () => {
    expect(roundToQuarter(12.3)).toBe(12.25);
    expect(roundToQuarter(12.4)).toBe(12.5);
    expect(roundToQuarter(12.125)).toBe(12.25);
  });

  it('weights a raw score inside its category ceiling', () => {
    expect(weightedScore('core_workflow', 25)).toBe(25);
    expect(weightedScore('core_workflow', 40)).toBe(25);
    expect(weightedScore('deck_demo', 4.3)).toBe(4.25);
    expect(weightedScore('practical_potential', -1)).toBe(0);
  });

  it('totals a full score set to at most 100', () => {
    const perfect = RUBRIC_CATEGORIES.map((c) => ({
      categoryKey: c.key,
      weightedScore: c.maxPoints,
    }));
    expect(totalScore(perfect)).toBe(100);

    const zeroed = RUBRIC_CATEGORIES.map((c) => ({ categoryKey: c.key, weightedScore: 0 }));
    expect(totalScore(zeroed)).toBe(0);
  });

  it('avoids floating-point drift across quarter-point scores', () => {
    const scores = RUBRIC_CATEGORIES.map((c) => ({
      categoryKey: c.key,
      weightedScore: roundToQuarter(c.maxPoints * 0.7),
    }));
    const total = totalScore(scores);
    expect(Number.isInteger(total * 100)).toBe(true);
  });
});

describe('score completeness', () => {
  it('rejects a partial score set', () => {
    const partial = RUBRIC_CATEGORIES.slice(0, 5).map((c) => ({
      categoryKey: c.key,
      weightedScore: 1,
    }));
    expect(isCompleteScoreSet(partial)).toBe(false);
  });

  it('accepts a full score set', () => {
    const full = RUBRIC_CATEGORIES.map((c) => ({ categoryKey: c.key, weightedScore: 1 }));
    expect(isCompleteScoreSet(full)).toBe(true);
  });
});

describe('category lookup', () => {
  it('throws on an unknown key rather than returning a default', () => {
    // A silent default here would let an unknown category score silently.
    expect(() => getRubricCategory('not_a_category' as never)).toThrow(/Unknown rubric category/);
  });
});
