import { describe, expect, it } from 'vitest';
import { AIAP_C14_CATALOGUE, AIAP_C14_EXTERNAL_COHORT_ID, AIAP_C14_IDEAS } from './aiap-c14';
import { findCohortIdeaCatalogue } from './index';
import { catalogueCategories, validateIdeaCatalogue } from '../../domain/idea-catalogue';
import { IDEA_SEEDS } from '../../fixtures/ideas';
import { parseSheetRows, SHEET_HEADERS } from '../../intake/sheet-rows';

/**
 * The C14 catalogue as a contract with the upstream form.
 *
 * The submission product writes one of eight exact strings into "Category".
 * These tests pin that every one of them is recognised, that nothing from the
 * C13 catalogue slips through, and that the definitions are complete enough to
 * drive a test plan.
 */

const CANONICAL_TITLES = [
  'Personal Health Manager',
  'Personal Finance Manager',
  'Collaborative Notetaker',
  'Task Management App',
  'AI Interior Makeover',
  'Resume-to-Interview Coach',
  'Pet Care Companion',
  'Campaign Planner',
];

const CANONICAL_SLUGS = [
  'personal-health-manager',
  'personal-finance-manager',
  'collaborative-notetaker',
  'task-management-app',
  'ai-interior-makeover',
  'resume-to-interview-coach',
  'pet-care-companion',
  'campaign-planner',
];

describe('the C14 idea catalogue', () => {
  it('declares exactly the eight canonical titles, in announced order', () => {
    expect(AIAP_C14_IDEAS.map((i) => i.title)).toEqual(CANONICAL_TITLES);
    expect(AIAP_C14_IDEAS.map((i) => i.displayOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('uses the canonical slugs, each unique', () => {
    expect(AIAP_C14_IDEAS.map((i) => i.slug)).toEqual(CANONICAL_SLUGS);
    expect(new Set(CANONICAL_SLUGS).size).toBe(8);
  });

  it('has unique titles', () => {
    expect(new Set(AIAP_C14_IDEAS.map((i) => i.title.toLowerCase())).size).toBe(8);
  });

  it('is internally valid: every definition complete, orders 1–8', () => {
    expect(validateIdeaCatalogue(AIAP_C14_IDEAS)).toEqual({ valid: true, problems: [] });
  });

  it('gives every idea a non-empty expanded definition', () => {
    for (const idea of AIAP_C14_IDEAS) {
      for (const field of [
        'description',
        'targetUser',
        'expectedUseCase',
        'aiOpportunity',
        'allowedScope',
        'unsafeInterpretations',
      ] as const) {
        expect(idea[field].trim().length, `${idea.slug}.${field}`).toBeGreaterThan(20);
      }
      expect(idea.minimumCoreFlow.length, `${idea.slug} core flow`).toBeGreaterThanOrEqual(5);
      expect(idea.expectedEntities.length, `${idea.slug} entities`).toBeGreaterThanOrEqual(3);
      expect(idea.expectedEntities).toContain('User');
    }
  });

  it('carries no build-stack requirement — the stack is not a judging criterion', () => {
    const text = JSON.stringify(AIAP_C14_IDEAS).toLowerCase();
    for (const tool of ['bolt', 'supabase', 'openai', 'lovable', 'vercel', 'firebase']) {
      expect(text, `catalogue mentions ${tool}`).not.toContain(tool);
    }
  });

  it('is bound to the AIAP-C14 external identity and looked up only by it', () => {
    expect(AIAP_C14_CATALOGUE.externalCohortId).toBe('AIAP-C14');
    expect(AIAP_C14_EXTERNAL_COHORT_ID).toBe('AIAP-C14');
    expect(findCohortIdeaCatalogue('AIAP-C14')).toBe(AIAP_C14_CATALOGUE);
    // Names and near-misses never resolve: the mapping is by identifier only.
    expect(findCohortIdeaCatalogue('AIAP C14')).toBeNull();
    expect(findCohortIdeaCatalogue('aiap-c14')).toBeNull();
    expect(findCohortIdeaCatalogue('AIAP-C13')).toBeNull();
  });

  it('runs with a private top 10 and three human-chosen winners', () => {
    expect(AIAP_C14_CATALOGUE.settings).toEqual({ shortlistTarget: 10, finalSelectionTarget: 3 });
  });

  it('replaces seven of the C13 seeds and keeps only Collaborative Notetaker', () => {
    const c13 = new Set(IDEA_SEEDS.map((i) => i.slug));
    const kept = CANONICAL_SLUGS.filter((slug) => c13.has(slug));
    expect(kept).toEqual(['collaborative-notetaker']);
  });
});

describe('sheet categories against the C14 catalogue', () => {
  const headers = [...SHEET_HEADERS];
  const row = (category: string, group = 12): string[] =>
    headers.map((header) => {
      switch (header) {
        case 'Group Number':
          return String(group);
        case 'Category':
          return category;
        case 'Product Name':
          return 'A product';
        case 'MVP/Product Link':
          return 'https://product.example.com';
        case 'Access':
          return 'Open (any account works)';
        case 'Brief Description':
        case 'Main User Action':
        case 'How AI Helps':
        case 'What We Got Working':
          return 'Some text.';
        default:
          return '';
      }
    });
  const categories = catalogueCategories(AIAP_C14_IDEAS);

  it('accepts every canonical title exactly as the form writes it', () => {
    const parsed = parseSheetRows(
      [headers, ...CANONICAL_TITLES.map((title, index) => row(title, index + 1))],
      { approvedCategories: categories },
    );
    expect(parsed.invalid).toEqual([]);
    expect(parsed.valid.map((r) => r.input.ideaSlug)).toEqual(CANONICAL_SLUGS);
  });

  it('accepts the canonical slug too, and tolerates case and spacing', () => {
    const parsed = parseSheetRows(
      [headers, row('resume-to-interview-coach', 1), row('  AI interior makeover ', 2), row('PET CARE COMPANION', 3)],
      { approvedCategories: categories },
    );
    expect(parsed.invalid).toEqual([]);
    expect(parsed.valid.map((r) => r.input.ideaSlug)).toEqual([
      'resume-to-interview-coach',
      'ai-interior-makeover',
      'pet-care-companion',
    ]);
  });

  it('blocks the retired C13 categories rather than guessing', () => {
    const retired = IDEA_SEEDS.filter((i) => i.slug !== 'collaborative-notetaker').map((i) => i.title);
    const parsed = parseSheetRows(
      [headers, ...retired.map((title, index) => row(title, index + 1))],
      { approvedCategories: categories },
    );
    expect(parsed.valid).toEqual([]);
    expect(parsed.invalid.map((i) => i.field)).toEqual(retired.map(() => 'Category'));
  });

  it('blocks a near miss deterministically — no fuzzy matching', () => {
    const parsed = parseSheetRows([headers, row('Personal Health Tracker', 1), row('Campaign Planner App', 2)], {
      approvedCategories: categories,
    });
    expect(parsed.valid).toEqual([]);
    expect(parsed.invalid).toHaveLength(2);
  });
});
