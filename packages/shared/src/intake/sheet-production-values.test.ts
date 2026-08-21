import { describe, expect, it } from 'vitest';
import { APPROVED_IDEA_LABELS } from '../fixtures/ideas';
import { SHEET_HEADERS, normaliseAccessMode, parseSheetRows } from './sheet-rows';

/**
 * The values the submission product actually writes.
 *
 * Both bugs here were the same mistake in different places: the Judge validated
 * against its own vocabulary rather than against what really arrives. Two real
 * submissions were rejected — a legitimate Recipe Sharing App with an Access
 * value that was entirely correct — and neither rejection was the learner's
 * fault.
 *
 * These tests use the exact strings observed in production, so a future change
 * to either vocabulary fails here rather than on the morning of the event.
 */

/** Exactly as the upstream form presents them. */
const PRODUCT_ACCESS_OPEN = 'Open (any account works)';
const PRODUCT_ACCESS_LOGIN = 'Requires shared credentials';

const row = (over: Record<string, string> = {}) => ({
  Timestamp: '2026-08-21 18:30:00',
  'Group Number': '102',
  Category: 'Recipe Sharing App',
  'Product Name': 'Sizzle',
  'Team Leader': 'Test Lead',
  'Team Members': 'Test Lead',
  'Primary Contact': 'lead@example.invalid',
  'MVP/Product Link': 'https://sizzle.example.com',
  Access: PRODUCT_ACCESS_OPEN,
  'Login Email': '',
  'Login Password': '',
  'Brief Description': 'Share recipes with friends.',
  'Main User Action': 'Post a recipe and see it appear in the feed.',
  'How AI Helps': 'It suggests tags for the recipe.',
  'What We Got Working': 'Posting and browsing recipes.',
  'Loom Video Link': '',
  'Final Deck Link': '',
  ...over,
});

const sheet = (rows: Record<string, string>[]) => [
  [...SHEET_HEADERS],
  ...rows.map((r) => SHEET_HEADERS.map((h) => r[h] ?? '')),
];

/** No cohort catalogue — the state a first Preview is actually in. */
const previewParse = (rows: string[][]) =>
  parseSheetRows(rows, { approvedCategories: [...APPROVED_IDEA_LABELS] });

describe('Access, as the submission product writes it', () => {
  it('reads "Open (any account works)" as open access', () => {
    expect(normaliseAccessMode(PRODUCT_ACCESS_OPEN)).toBe('open');
  });

  it('reads "Requires shared credentials" as a specific login', () => {
    expect(normaliseAccessMode(PRODUCT_ACCESS_LOGIN)).toBe('credentials');
  });

  it('still reads our own canonical labels', () => {
    expect(normaliseAccessMode('Open Access')).toBe('open');
    expect(normaliseAccessMode('Specific Login')).toBe('credentials');
  });

  it('tolerates the casing and spacing a human introduces', () => {
    expect(normaliseAccessMode('  OPEN (ANY ACCOUNT WORKS)  ')).toBe('open');
    expect(normaliseAccessMode('requires  shared   credentials')).toBe('credentials');
  });

  it('still refuses anything it does not recognise', () => {
    /*
     * The reason this is a list and not a fuzzy rule. Access decides whether a
     * browser is sent at a login wall with no credentials — a guess there ends
     * with a working product scored as broken.
     */
    for (const value of ['ask us', 'partially open', 'maybe', 'open-ish', '']) {
      expect(normaliseAccessMode(value), value).toBeNull();
    }
  });

  it('requires credentials when the product says a login is needed', () => {
    const result = previewParse(sheet([row({ Access: PRODUCT_ACCESS_LOGIN })]));
    expect(result.valid).toHaveLength(0);
    expect(result.invalid.map((i) => i.field)).toEqual(
      expect.arrayContaining(['Login Email', 'Login Password']),
    );
  });

  it('accepts a specific-login row that carries them', () => {
    const [only] = previewParse(
      sheet([
        row({
          Access: PRODUCT_ACCESS_LOGIN,
          'Login Email': 'judge@example.invalid',
          'Login Password': 'pw',
        }),
      ]),
    ).valid;

    expect(only!.input.accessMode).toBe('credentials');
    expect(only!.credentials).toEqual({ username: 'judge@example.invalid', password: 'pw' });
    // And the password is still nowhere near the payload.
    expect(JSON.stringify(only!.input)).not.toContain('pw');
  });

  it('needs no credentials for an open product', () => {
    const [only] = previewParse(sheet([row()])).valid;
    expect(only!.input.accessMode).toBe('open');
    expect(only!.credentials).toBeNull();
  });
});

describe('the eight approved ideas', () => {
  it('is one canonical list, derived from the seeds', () => {
    expect(APPROVED_IDEA_LABELS).toHaveLength(8);
    expect(APPROVED_IDEA_LABELS.map((i) => i.title).sort()).toEqual(
      [
        'Book Recommendation App',
        'Budget Tracker',
        'Collaborative Notetaker',
        'Fitness Goal Tracker',
        'Movie Watchlist',
        'Recipe Sharing App',
        'Travel Itinerary Planner',
        'Website Content Scraper',
      ].sort(),
    );
  });

  it('resolves every display label a learner can pick', () => {
    // Not just the one that was reported. All eight, by their exact labels.
    for (const idea of APPROVED_IDEA_LABELS) {
      const result = previewParse(sheet([row({ Category: idea.title })]));
      expect(result.valid, idea.title).toHaveLength(1);
      expect(result.valid[0]!.input.ideaSlug, idea.title).toBe(idea.slug);
    }
  });

  it('resolves Recipe Sharing App, which production rejected', () => {
    const [only] = previewParse(sheet([row({ Category: 'Recipe Sharing App' })])).valid;
    expect(only!.input.ideaSlug).toBe('recipe-sharing-app');
  });

  it('also accepts the internal slug where one is written instead', () => {
    const [only] = previewParse(sheet([row({ Category: 'recipe-sharing-app' })])).valid;
    expect(only!.input.ideaSlug).toBe('recipe-sharing-app');
  });

  it('tolerates casing and spacing in the label', () => {
    const [only] = previewParse(sheet([row({ Category: '  recipe sharing app ' })])).valid;
    expect(only!.input.ideaSlug).toBe('recipe-sharing-app');
  });

  it('still refuses an idea that is not on the list', () => {
    const result = previewParse(sheet([row({ Category: 'Crypto Trading Bot' })]));
    expect(result.valid).toHaveLength(0);
    expect(result.invalid[0]!.field).toBe('Category');
  });
});

describe('the two rows currently in the production sheet', () => {
  it('accepts the Sizzle row exactly as the product wrote it', () => {
    /*
     * The end-to-end shape of the report: this is the row that was blocked, in
     * its real form, and it must now be ready to import.
     */
    const result = previewParse(sheet([row()]));

    expect(result.valid).toHaveLength(1);
    const only = result.valid[0]!;
    expect(only.groupNumber).toBe(102);
    expect(only.input.productName).toBe('Sizzle');
    expect(only.input.ideaSlug).toBe('recipe-sharing-app');
    expect(only.input.accessMode).toBe('open');
  });

  it('keeps a genuinely invalid row blocked, for its own reasons', () => {
    // Fixing the vocabulary must not start letting broken rows through.
    const result = previewParse(
      sheet([row({ 'MVP/Product Link': '', 'Main User Action': '' })]),
    );
    expect(result.valid).toHaveLength(0);
    expect(result.invalid.map((i) => i.field)).toEqual(
      expect.arrayContaining(['MVP/Product Link', 'Main User Action']),
    );
  });

  it('still carries no learner PII into the payload', () => {
    const [only] = previewParse(sheet([row()])).valid;
    const payload = JSON.stringify(only!.input).toLowerCase();
    for (const pii of ['test lead', 'lead@example.invalid']) {
      expect(payload, pii).not.toContain(pii);
    }
  });

  it('still resolves a resubmission to the latest valid row', () => {
    const result = previewParse(
      sheet([
        row({ Timestamp: '2026-08-21 14:00:00', 'Product Name': 'Sizzle' }),
        row({ Timestamp: '2026-08-21 18:00:00', 'Product Name': 'Sizzle v2' }),
      ]),
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.input.productName).toBe('Sizzle v2');
    expect(result.resubmittedGroups[0]!.supersededRows).toEqual([2]);
  });
});
