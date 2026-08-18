import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildTeamStore } from './repositories/teams';
import { makeCohort } from './testing/assessment-fixtures';
import { buildAccessCodeCsv, buildLearnerMessage } from '../../utils/csv';
import { parseCsv } from '../../utils/csv';

/**
 * The plaintext code exists once, in one file, and nowhere else.
 *
 * The whole access-code design rests on this. Only an Argon2id hash is stored,
 * there is deliberately no method to read a code back, and a lost code is
 * replaced rather than recovered — which is a real operational cost, accepted
 * on purpose.
 *
 * Adding a ready-to-send message to the sheet puts the plaintext into a second
 * string, and a second string is a second thing that could be written down.
 * These tests exist because the convenience is only acceptable while it stays
 * strictly in memory: built at issuance, handed to the operator, and gone.
 */

let db: PgliteHandle;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

let cohortId: string;

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test rubric', true)`,
  );
  const cohort = await makeCohort(db, 'PLAIN');
  cohortId = cohort.id;
});

/** Every text-ish value in the database, as one haystack. */
async function everythingStored(): Promise<string> {
  const { rows: tables } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );

  const chunks: string[] = [];
  for (const { table_name } of tables) {
    // `to_jsonb(t)` renders every column of every row, whatever its type, so a
    // code hidden in a jsonb payload or an audit blob is caught too.
    const { rows } = await db.query<{ blob: string }>(
      `select coalesce(string_agg(to_jsonb(t)::text, ' '), '') as blob from "${table_name}" t`,
    );
    chunks.push(rows[0]?.blob ?? '');
  }
  return chunks.join(' ');
}

describe('issuing codes', () => {
  it('stores no plaintext code anywhere in the database', async () => {
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohortId, [
      { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@example.com' }] },
      { groupNumber: 2, whatsappLink: null, learners: [{ name: 'B', email: 'b@example.com' }] },
      { groupNumber: 3, whatsappLink: null, learners: [{ name: 'C', email: 'c@example.com' }] },
    ]);

    const issued = await teams.generateAccessCodes({ cohortId, regenerate: false });
    expect(issued).toHaveLength(3);

    const stored = await everythingStored();
    for (const row of issued) {
      expect(row.code.length).toBeGreaterThan(10);
      expect(stored, `group ${row.groupNumber}'s code was written to the database`).not.toContain(
        row.code,
      );
      // Nor with the dashes stripped, which is how a code is normalised before
      // it is hashed — the shape a careless log line would most likely take.
      expect(stored).not.toContain(row.code.replace(/-/g, ''));
    }
  });

  it('stores no learner message, and nothing containing a code', async () => {
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohortId, [
      { groupNumber: 7, whatsappLink: null, learners: [{ name: 'A', email: 'a@example.com' }] },
    ]);
    const [row] = await teams.generateAccessCodes({ cohortId, regenerate: false });

    const message = buildLearnerMessage({
      groupNumber: row!.groupNumber,
      code: row!.code,
      submitUrl: 'https://example.test/submit',
    });

    const stored = await everythingStored();
    expect(stored).not.toContain(message);
    expect(stored).not.toContain(row!.code);
    // The message is not a stored artefact at all — no fragment of it is there.
    expect(stored).not.toContain('Hackathon submission portal');
    expect(stored).not.toContain('do not share it outside your group');
  });

  it('keeps only a hash, and the hash is not the code', async () => {
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohortId, [
      { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@example.com' }] },
    ]);
    const [row] = await teams.generateAccessCodes({ cohortId, regenerate: false });

    const { rows } = await db.query<{ code_hash: string }>(
      'select code_hash from team_access_codes where revoked_at is null',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toMatch(/^\$argon2/);
    expect(rows[0]!.code_hash).not.toContain(row!.code);
  });

  it('offers no way to read a code back', async () => {
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohortId, [
      { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@example.com' }] },
    ]);
    await teams.generateAccessCodes({ cohortId, regenerate: false });

    // The status view an operator sees carries whether a code exists, never
    // what it is.
    const status = await teams.listAccessCodeStatus(cohortId);
    expect(status[0]!.hasCode).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/[A-Z]{4}-[A-Z]{4}-[A-Z]{4}/);
    expect(Object.keys(status[0]!)).not.toContain('code');
  });
});

// --------------------------------------------------------------------------
// The message itself
// --------------------------------------------------------------------------

describe('the learner message', () => {
  const message = buildLearnerMessage({
    groupNumber: 41,
    code: 'ABCD-EFGH-JKMN',
    submitUrl: 'https://judge.example.test/submit',
  });

  it('says what a team needs and nothing else', () => {
    expect(message).toContain('Hackathon submission portal');
    expect(message).toContain('Group: 41');
    expect(message).toContain('Access code: ABCD-EFGH-JKMN');
    expect(message).toContain('Submit here: https://judge.example.test/submit');
    expect(message).toContain('This code is shared by your team.');
  });

  it('carries the group number, so a mis-paste is visible to the team that gets it', () => {
    // Sixty-five threads, sixty-five pastes. The group number in the message is
    // what lets the wrong team notice immediately rather than at the deadline.
    const other = buildLearnerMessage({
      groupNumber: 14,
      code: 'ABCD-EFGH-JKMN',
      submitUrl: 'https://judge.example.test/submit',
    });
    expect(other).toContain('Group: 14');
    expect(other).not.toBe(message);
  });

  it('is short enough to send as one message', () => {
    expect(message.length).toBeLessThan(320);
    expect(message.split('\n').filter(Boolean)).toHaveLength(5);
  });
});

// --------------------------------------------------------------------------
// The file
// --------------------------------------------------------------------------

describe('the distribution sheet', () => {
  const rows = [
    { groupNumber: 41, leadName: 'A Lead', leadEmail: 'lead@example.com', whatsappLink: 'https://chat.example.test/41', memberCount: 4, code: 'ABCD-EFGH-JKMN' },
    { groupNumber: 42, leadName: null, leadEmail: null, whatsappLink: null, memberCount: 0, code: 'PQRS-TUVW-XYZ2' },
  ];
  const csv = buildAccessCodeCsv(rows, 'https://judge.example.test/submit');
  const parsed = parseCsv(csv);

  it('keeps every existing column, in its existing position', () => {
    expect(parsed[0]).toEqual([
      'Group Number',
      'Members',
      'WhatsApp Link',
      'Team Lead',
      'Lead Email',
      'Access Code',
      'Submission URL',
      'Learner Message',
    ]);
  });

  it('carries a complete message per team', () => {
    expect(parsed[1]![7]).toBe(
      buildLearnerMessage({ groupNumber: 41, code: 'ABCD-EFGH-JKMN', submitUrl: 'https://judge.example.test/submit' }),
    );
    expect(parsed[2]![7]).toContain('Group: 42');
    expect(parsed[2]![7]).toContain('PQRS-TUVW-XYZ2');
  });

  it('survives a spreadsheet, despite the newlines', () => {
    // A multi-line cell has to be quoted or every row after it is destroyed.
    expect(csv).toContain('"Hackathon submission portal');
    // Round-trips: two data rows, eight columns each.
    expect(parsed.filter((row) => row.length > 1)).toHaveLength(3);
    for (const row of parsed) expect(row).toHaveLength(8);
  });

  it('still refuses to become a spreadsheet formula', () => {
    const hostile = buildAccessCodeCsv(
      [{ ...rows[0]!, leadName: '=cmd|calc' }],
      'https://judge.example.test/submit',
    );
    expect(hostile).toContain("'=cmd|calc");
  });
});
