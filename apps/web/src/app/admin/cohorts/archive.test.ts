import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canTransitionCohort } from '@ohj/shared';

/**
 * Retiring a cohort from the screen an operator is actually looking at.
 *
 * Archive existed in the domain and the repository and was unreachable in
 * practice. The lifecycle table offered it only from `finalised`, and the only
 * route there ran through judging — so the safe way to retire a cohort that
 * would never be judged was to fake a judging run first.
 *
 * Worse, the entry was wired to a plain status change. That sets the column and
 * stops: participant sessions stay live against a retired cohort until they
 * expire on their own, and the audit trail records a generic status change
 * rather than an archive.
 *
 * Found when the operator went looking for the button on a real open cohort.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const controls = () => readFile(resolve(HERE, 'lifecycle-controls.tsx'), 'utf8');
const actions = () => readFile(resolve(HERE, '../../../server/admin-actions.ts'), 'utf8');

describe('the lifecycle a cohort can actually follow', () => {
  it('lets an open cohort be closed', () => {
    // The step that was missing from the interface entirely. Without it the
    // lifecycle stopped at `open`, and nothing downstream was reachable.
    expect(canTransitionCohort('open', 'closed').allowed).toBe(true);
  });

  it('offers Close submissions from open and from paused', async () => {
    const text = await controls();
    const open = text.slice(text.indexOf('  open: ['), text.indexOf('  paused: ['));
    const paused = text.slice(text.indexOf('  paused: ['), text.indexOf('  closed: ['));

    expect(open).toContain('Close submissions');
    expect(paused).toContain('Close submissions');
  });

  it('lets a closed cohort be archived without judging it', () => {
    // A rehearsal, a pilot or an acceptance test is never judged, and forcing
    // one through judging to retire it is worse than allowing this.
    expect(canTransitionCohort('closed', 'archived').allowed).toBe(true);
  });

  it('still refuses to archive a cohort learners are using', () => {
    // A cohort open to teams must be closed first, not retired underneath them.
    expect(canTransitionCohort('open', 'archived').allowed).toBe(false);
    expect(canTransitionCohort('paused', 'archived').allowed).toBe(false);
  });

  it('keeps archived terminal', () => {
    for (const to of ['open', 'paused', 'closed', 'judging', 'finalised'] as const) {
      expect(canTransitionCohort('archived', to).allowed, to).toBe(false);
    }
  });
});

describe('what the Archive button calls', () => {
  it('is the archive action, never a plain status change', async () => {
    const text = await controls();
    expect(text).toMatch(/viaArchiveAction\s*\?\s*\n?\s*\/\/[\s\S]*?await archiveCohortAction\(formData\)/);
  });

  it('marks every archive entry to use it', async () => {
    const text = await controls();
    const archiveEntries = [...text.matchAll(/label: 'Archive cohort'/g)];
    const viaAction = [...text.matchAll(/viaArchiveAction: true/g)];

    expect(archiveEntries.length).toBeGreaterThan(0);
    expect(viaAction.length, 'every Archive entry must route to the archive action').toBe(
      archiveEntries.length,
    );
  });

  it('revokes participant sessions, which a status change does not', async () => {
    const repo = await readFile(
      resolve(HERE, '../../../../../../packages/shared/src/data/postgres/repositories/admin.ts'),
      'utf8',
    );
    const archive = repo.slice(repo.indexOf('async archiveCohort'), repo.indexOf('async deleteCohortPermanently'));
    expect(archive).toMatch(/update participant_sessions set revoked_at = now\(\)/);
    expect(archive).toMatch(/cohort\.archived/);
  });
});

describe('the confirmation an operator reads', () => {
  it('names the cohort, so nobody retires the wrong one', async () => {
    expect(await controls()).toMatch(/Archive "\$\{name\}"\?/);
  });

  it('says plainly that nothing is deleted', async () => {
    const text = await controls();
    expect(text).toMatch(/This is not deletion/);
    expect(text).toMatch(/submissions, receipts, uploaded files, audit history/);
  });

  it('warns that learner access ends immediately', async () => {
    expect(await controls()).toMatch(/any team still signed in is signed out/);
  });

  it('counts unjudged work, because that is the part worth pausing over', async () => {
    const text = await controls();
    expect(text).toMatch(/have not been judged, and archiving is permanent/);
    expect(text).toMatch(/If you intend to judge them, start judging instead/);
  });

  it('says it cannot be reopened', async () => {
    expect(await controls()).toMatch(/cannot be reopened/);
  });
});

describe('permanent deletion', () => {
  it('is still not exposed anywhere in the admin interface', async () => {
    // The refusal is worth more than a button. `deleteCohortPermanently` stays
    // reachable only from code, so a cohort holding real work cannot be removed
    // by a mis-click on the day.
    const text = await actions();
    expect(text).not.toMatch(/deleteCohortPermanently/);
  });
});
