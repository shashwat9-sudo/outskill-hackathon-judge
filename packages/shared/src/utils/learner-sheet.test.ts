import { describe, expect, it } from 'vitest';
import {
  buildImportPreview,
  buildRejectedRowsCsv,
  mapColumns,
  parseLearnerSheet,
} from './learner-sheet';

/**
 * The real Outskill learner allocation sheet.
 *
 * One row per LEARNER, many learners per group. The failure this guards against
 * is quiet: 1,000 learner rows becoming 1,000 teams instead of 100, or a
 * mistyped group silently creating a team of one.
 */

const SHEET = `Name,Email,Group,Link
Learner A,a@example.invalid,1,https://chat.whatsapp.com/group1
Learner B,b@example.invalid,1,https://chat.whatsapp.com/group1
Learner C,c@example.invalid,1,https://chat.whatsapp.com/group1
Learner D,d@example.invalid,2,https://chat.whatsapp.com/group2
Learner E,e@example.invalid,2,https://chat.whatsapp.com/group2`;

describe('column matching', () => {
  it('reads the real Outskill headings', () => {
    const mapping = mapColumns(['Name', 'Email', 'Group', 'Link']);
    expect(mapping).toMatchObject({ name: 0, email: 1, groupNumber: 2, whatsappLink: 3 });
  });

  it('tolerates spacing and capitalisation', () => {
    const mapping = mapColumns(['  NAME ', 'Email Address', 'Group Number', 'WhatsApp Link']);
    expect(mapping).toMatchObject({ name: 0, email: 1, groupNumber: 2, whatsappLink: 3 });
  });

  it('works without the optional Link column', () => {
    const mapping = mapColumns(['Name', 'Email', 'Group']);
    expect(mapping).toMatchObject({ whatsappLink: null });
  });

  it('refuses to guess at an unrelated column', () => {
    // Fuzzy matching would eventually decide "Mentor Email" is the learner
    // email, and every learner would import under the wrong identity.
    const result = mapColumns(['Learner', 'Mentor Contact', 'Cohort Batch']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/Email, Group/);
  });

  it('names what it did find, so the operator can see the mismatch', () => {
    const result = mapColumns(['Participant', 'Contact']);
    expect((result as { error: string }).error).toContain('"Participant"');
  });

  it('reports unrecognised columns rather than failing on them', () => {
    const mapping = mapColumns(['Name', 'Email', 'Group', 'Link', 'Mentor', 'Notes']);
    expect(mapping).toMatchObject({ unmatched: ['Mentor', 'Notes'] });
  });
});

describe('parsing', () => {
  it('reads every learner row', () => {
    const parsed = parseLearnerSheet(SHEET);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.rows[0]).toMatchObject({ name: 'Learner A', groupNumber: 1, rowNumber: 2 });
  });

  it('accepts a pasted spreadsheet selection', () => {
    // An operator who has just selected 1,000 rows should not have to export a
    // file first.
    const pasted = 'Name\tEmail\tGroup\tLink\nLearner A\ta@example.invalid\t1\tlink1';
    const parsed = parseLearnerSheet(pasted);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.whatsappLink).toBe('link1');
  });

  it('handles quoted cells containing commas', () => {
    const csv = 'Name,Email,Group\n"Patel, Priya",p@example.invalid,3';
    expect(parseLearnerSheet(csv).rows[0]?.name).toBe('Patel, Priya');
  });

  it('lower-cases emails so the same learner matches on re-import', () => {
    const csv = 'Name,Email,Group\nA,A@Example.Invalid,1';
    expect(parseLearnerSheet(csv).rows[0]?.email).toBe('a@example.invalid');
  });

  it('skips blank lines without reporting them', () => {
    const csv = `Name,Email,Group\nA,a@example.invalid,1\n\n\nB,b@example.invalid,2`;
    const parsed = parseLearnerSheet(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rejected).toHaveLength(0);
  });

  it('keeps row numbers matching the spreadsheet', () => {
    // An operator fixing an error needs to find the row in their own file.
    const parsed = parseLearnerSheet(SHEET);
    expect(parsed.rows[0]?.rowNumber).toBe(2);
    expect(parsed.rows[4]?.rowNumber).toBe(6);
  });
});

describe('rejecting bad rows', () => {
  const bad = `Name,Email,Group,Link
,a@example.invalid,1,link
Learner B,,1,link
Learner C,not-an-email,1,link
Learner D,d@example.invalid,,link
Learner E,e@example.invalid,abc,link
Learner F,f@example.invalid,0,link
Learner G,g@example.invalid,1000,link
Learner H,h@example.invalid,2,link`;

  it('rejects each malformed row with a specific reason', () => {
    const parsed = parseLearnerSheet(bad);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(7);

    const reasons = parsed.rejected.map((r) => r.reason);
    expect(reasons[0]).toMatch(/missing Name/);
    expect(reasons[1]).toMatch(/missing Email/);
    expect(reasons[2]).toMatch(/not a valid email/);
    expect(reasons[3]).toMatch(/missing Group/);
    expect(reasons[4]).toMatch(/not a number/);
    expect(reasons[5]).toMatch(/outside the allowed range/);
    expect(reasons[6]).toMatch(/outside the allowed range/);
  });

  it('never silently discards a bad row', () => {
    const parsed = parseLearnerSheet(bad);
    // Every non-blank row is either imported or reported.
    expect(parsed.rows.length + parsed.rejected.length).toBe(8);
  });

  it('keeps the original cells so the row can be found and fixed', () => {
    const parsed = parseLearnerSheet(bad);
    expect(parsed.rejected[1]?.raw.Name).toBe('Learner B');
  });

  it('produces a downloadable error report', () => {
    const csv = buildRejectedRowsCsv(parseLearnerSheet(bad).rejected);
    expect(csv.split('\r\n')[0]).toBe('Row,Problem,Name,Email,Group,Link');
    expect(csv).toContain('Learner C');
    expect(csv).toContain('not a valid email');
  });
});

describe('the preview', () => {
  it('turns many learner rows into one team per group', () => {
    // The central point: 5 learners, 2 groups, 2 teams — never 5 teams.
    const preview = buildImportPreview(parseLearnerSheet(SHEET), []);
    expect(preview.learnerRowsRead).toBe(5);
    expect(preview.uniqueGroups).toBe(2);
    expect(preview.newTeams).toBe(2);
    expect(preview.groups[0]?.learners).toHaveLength(3);
    expect(preview.groups[1]?.learners).toHaveLength(2);
  });

  it('scales the way the real sheet will', () => {
    const rows = ['Name,Email,Group,Link'];
    for (let group = 1; group <= 100; group++) {
      for (let learner = 0; learner < 10; learner++) {
        rows.push(`L${group}-${learner},l${group}-${learner}@example.invalid,${group},link${group}`);
      }
    }
    const preview = buildImportPreview(parseLearnerSheet(rows.join('\n')), []);

    expect(preview.learnerRowsRead).toBe(1000);
    expect(preview.uniqueGroups).toBe(100);
    expect(preview.newTeams).toBe(100);
  });

  it('distinguishes groups that already exist', () => {
    const preview = buildImportPreview(parseLearnerSheet(SHEET), [1]);
    expect(preview.existingTeamsMatched).toBe(1);
    expect(preview.newTeams).toBe(1);
    expect(preview.groups.find((g) => g.groupNumber === 1)?.existing).toBe(true);
  });

  it('carries one WhatsApp link per group', () => {
    const preview = buildImportPreview(parseLearnerSheet(SHEET), []);
    expect(preview.groups[0]?.whatsappLink).toBe('https://chat.whatsapp.com/group1');
  });

  it('orders groups numerically', () => {
    const csv = 'Name,Email,Group\nA,a@x.invalid,10\nB,b@x.invalid,2\nC,c@x.invalid,1';
    const preview = buildImportPreview(parseLearnerSheet(csv), []);
    expect(preview.groups.map((g) => g.groupNumber)).toEqual([1, 2, 10]);
  });
});

describe('warnings', () => {
  const warningsFor = (csv: string, existing: number[] = []) =>
    buildImportPreview(parseLearnerSheet(csv), existing).warnings.map((w) => w.code);

  it('flags a learner appearing in two groups', () => {
    const csv = `Name,Email,Group\nA,a@x.invalid,1\nA,a@x.invalid,2`;
    expect(warningsFor(csv)).toContain('learner_in_multiple_groups');
  });

  it('flags the same learner listed twice in one group, and de-duplicates', () => {
    const csv = `Name,Email,Group\nA,a@x.invalid,1\nA,a@x.invalid,1\nB,b@x.invalid,1`;
    const preview = buildImportPreview(parseLearnerSheet(csv), []);
    expect(preview.warnings.map((w) => w.code)).toContain('duplicate_learner_in_group');
    expect(preview.groups[0]?.learners).toHaveLength(2);
  });

  it('flags conflicting WhatsApp links inside one group', () => {
    const csv = `Name,Email,Group,Link\nA,a@x.invalid,1,linkA\nB,b@x.invalid,1,linkB`;
    expect(warningsFor(csv)).toContain('conflicting_whatsapp_links');
  });

  it('flags an unusually small group', () => {
    expect(warningsFor('Name,Email,Group\nA,a@x.invalid,1')).toContain('small_group');
  });

  it('flags an unusually large group', () => {
    const rows = ['Name,Email,Group'];
    for (let i = 0; i < 20; i++) rows.push(`L${i},l${i}@x.invalid,1`);
    expect(warningsFor(rows.join('\n'))).toContain('large_group');
  });

  it('flags rejected rows so they are not missed', () => {
    const csv = `Name,Email,Group\nA,a@x.invalid,1\nB,b@x.invalid,1\n,bad@x.invalid,1`;
    expect(warningsFor(csv)).toContain('rejected_rows');
  });

  it('notes a missing Link column rather than failing', () => {
    expect(warningsFor('Name,Email,Group\nA,a@x.invalid,1\nB,b@x.invalid,1')).toContain(
      'no_link_column',
    );
  });

  it('notes unrecognised columns', () => {
    const csv = 'Name,Email,Group,Link,Mentor\nA,a@x.invalid,1,l,M\nB,b@x.invalid,1,l,M';
    expect(warningsFor(csv)).toContain('unmatched_columns');
  });
});

describe('refusing to proceed', () => {
  it('reports an empty file', () => {
    expect(parseLearnerSheet('').error).toMatch(/empty/i);
  });

  it('is not importable when nothing usable was found', () => {
    const csv = 'Name,Email,Group\n,,\n,,';
    expect(buildImportPreview(parseLearnerSheet(csv), []).importable).toBe(false);
  });

  it('mutates nothing — a preview is a pure calculation', () => {
    // The import is a separate, confirmed step. Building a preview must never
    // be capable of writing.
    const parsed = parseLearnerSheet(SHEET);
    const before = JSON.stringify(parsed);
    buildImportPreview(parsed, []);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});

describe('cross-group duplicates block the import', () => {
  it('refuses rather than warning, because either outcome is wrong', () => {
    // Whichever team is created second would silently be missing them, or the
    // learner would hold two access codes. The per-team database index cannot
    // catch this, so the importer must.
    const csv = `Name,Email,Group\nPriya,p@x.invalid,1\nPriya,p@x.invalid,2\nB,b@x.invalid,1\nC,c@x.invalid,2`;
    const preview = buildImportPreview(parseLearnerSheet(csv), []);

    expect(preview.importable).toBe(false);
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]).toContain('p@x.invalid');
    expect(preview.blockers[0]).toMatch(/groups 1, 2/);
    expect(preview.blockers[0]).toMatch(/fix the sheet/i);
  });

  it('still allows the same learner twice within ONE group', () => {
    // A duplicated row in one group is untidy, not contradictory — it
    // de-duplicates to a single member.
    const csv = `Name,Email,Group\nPriya,p@x.invalid,1\nPriya,p@x.invalid,1\nB,b@x.invalid,1`;
    const preview = buildImportPreview(parseLearnerSheet(csv), []);

    expect(preview.importable).toBe(true);
    expect(preview.blockers).toHaveLength(0);
    expect(preview.groups[0]?.learners).toHaveLength(2);
  });

  it('is case-insensitive, matching the database', () => {
    const csv = `Name,Email,Group\nP,Priya@X.Invalid,1\nP,priya@x.invalid,2\nB,b@x.invalid,1\nC,c@x.invalid,2`;
    expect(buildImportPreview(parseLearnerSheet(csv), []).importable).toBe(false);
  });

  it('leaves a clean sheet importable', () => {
    const preview = buildImportPreview(parseLearnerSheet(SHEET), []);
    expect(preview.importable).toBe(true);
    expect(preview.blockers).toEqual([]);
  });
});
