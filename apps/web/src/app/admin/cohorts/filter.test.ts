import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Hiding archived cohorts, without losing them.
 *
 * Every rehearsal and acceptance run leaves a cohort behind, and they pile up
 * in front of the one an operator is actually running. The fix is a filter, and
 * the risk in a filter is that "hidden" quietly becomes "gone" — a later change
 * that filters at the query, or deletes to tidy up, would look identical on
 * screen and be irreversible.
 *
 * So the tests are mostly about what the filter must NOT do.
 */

const PAGE = resolve(dirname(fileURLToPath(import.meta.url)), 'page.tsx');
const source = () => readFile(PAGE, 'utf8');

/** Statements only. A comment about archiving is not archiving. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the default view', () => {
  it('shows everything that is not archived', async () => {
    const text = code(await source());
    expect(text).toMatch(/show === 'archived' \? cohort\.status === 'archived' : cohort\.status !== 'archived'/);
  });

  it('treats anything other than an explicit request as active', async () => {
    // A stray or hostile `?show=` value must land on the safe view rather than
    // an empty screen an operator cannot explain.
    const text = code(await source());
    expect(text).toMatch(/searchParams\)\.show === 'archived' \? 'archived' : 'active'/);
  });
});

describe('what the filter must not do', () => {
  it('reads every cohort, and filters in the page', async () => {
    // Filtering in the query would make "archived" a thing the page cannot
    // count, and the counts are how an operator knows the others still exist.
    const text = code(await source());
    expect(text).toMatch(/listCohorts\(\)/);
    expect(text).not.toMatch(/listCohorts\([^)]+\)/);
  });

  it('deletes nothing', async () => {
    const text = code(await source());
    for (const forbidden of ['delete', 'Delete', 'remove', 'purge', 'archiveCohort']) {
      expect(text, `the cohorts page referenced "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('changes no lifecycle behaviour', async () => {
    // The controls are untouched — the filter decides what is listed, and
    // nothing about what a listed cohort can do.
    const text = code(await source());
    expect(text).toMatch(/<LifecycleControls/);
    expect(text).toMatch(/<ClosureControls/);
    expect(text).not.toMatch(/setCohortStatus/);
  });

  it('keeps archived cohorts reachable, and says how many there are', async () => {
    const text = code(await source());
    expect(text).toMatch(/\/admin\/cohorts\?show=archived/);
    expect(text).toMatch(/archivedCount/);
    // Both counts are shown, so an operator can see the hidden ones exist.
    expect(text).toMatch(/\['active', 'Active', all\.length - archivedCount\]/);
    expect(text).toMatch(/\['archived', 'Archived', archivedCount\]/);
  });
});

describe('the empty states tell the truth', () => {
  it('distinguishes "none archived" from "none at all"', async () => {
    const text = await source();
    expect(text).toMatch(/No archived cohorts/);
    expect(text).toMatch(/No active cohorts/);
  });

  it('says archived cohorts keep their contents', async () => {
    const text = await source();
    expect(text).toMatch(/keep everything — submissions, receipts, uploads and history/);
  });
});

describe('the filter is navigable', () => {
  it('is a link, so it survives a reload and can be shared', async () => {
    const text = code(await source());
    const nav = text.slice(text.indexOf('data-testid="cohort-filter"'), text.indexOf('summaries.length === 0'));
    expect(nav).toMatch(/<Link/);
    // Not a client-side toggle: no state, so no way for the view to disagree
    // with the address bar.
    expect(nav).not.toMatch(/useState|onClick/);
  });

  it('marks the current view for a screen reader', async () => {
    const text = code(await source());
    expect(text).toMatch(/aria-current=\{show === key \? 'page' : undefined\}/);
  });
});
