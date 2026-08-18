import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildCohortStore } from './repositories/admin';
import { buildTeamStore } from './repositories/teams';
import type { LearnerAllocationGroup } from '../store';
import type { AssessmentConfig } from '../types';

/**
 * Importing the learner allocation sheet, against a real Postgres engine.
 *
 * The case that matters is the second import. A corrected sheet always arrives
 * — someone was in the wrong group, three people joined late, a name was
 * misspelled — and the operator re-uploads it under time pressure on the day.
 * An importer that duplicates teams or duplicates members on the second run is
 * worse than no importer, because the damage is discovered by learners.
 */

let db: PgliteHandle;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test rubric', true)`,
  );
});

const CONFIG: AssessmentConfig = {
  workerConcurrency: 4,
  browserBudgetMs: 480_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
  gracePeriodMs: 3_600_000,
  consistencyTopN: 20,
  lowConfidenceThreshold: 0.6,
  modelVersion: 'test',
  promptVersion: 'test',
};

async function makeCohort(code = 'IMPORT') {
  return buildCohortStore(db).createCohort({
    name: `Cohort ${code}`,
    code,
    description: '',
    timezone: 'Asia/Kolkata',
    // Relative, not a literal date: a fixed deadline turns every test that
    // needs an open window into a test that fails once that day passes.
    day12StartAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    day13DeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v1',
    assessmentConfig: CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
}

function group(n: number, learners: [string, string][], link: string | null = null): LearnerAllocationGroup {
  return {
    groupNumber: n,
    whatsappLink: link,
    learners: learners.map(([name, email]) => ({ name, email })),
  };
}

const SHEET: LearnerAllocationGroup[] = [
  group(1, [['Priya Sharma', 'priya@example.com'], ['Arjun Rao', 'arjun@example.com']], 'https://chat.whatsapp.com/g1'),
  group(2, [['Meera Iyer', 'meera@example.com']], 'https://chat.whatsapp.com/g2'),
];

describe('the first import', () => {
  it('creates one team per group with its learners', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);

    const result = await teams.importLearnerAllocation(cohort.id, SHEET);

    expect(result.teamsCreated).toBe(2);
    expect(result.learnersAdded).toBe(3);
    expect(result.failed).toEqual([]);

    const stored = await teams.listTeams(cohort.id);
    expect(stored.map((t) => t.groupNumber)).toEqual([1, 2]);
    expect(stored[0]?.members.map((m) => m.fullName)).toEqual(['Priya Sharma', 'Arjun Rao']);
  });

  it('leaves the lead fields empty rather than inventing one', async () => {
    // The sheet designates no lead. A placeholder would appear on the access
    // code sheet and in exports as though it were a real person.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.leadName).toBeNull();
    expect(team?.leadEmail).toBeNull();
  });

  it('stores the WhatsApp link', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    const result = await teams.importLearnerAllocation(cohort.id, SHEET);

    expect(result.whatsappLinksSet).toBe(2);
    const [team] = await teams.listTeams(cohort.id);
    expect(team?.whatsappLink).toBe('https://chat.whatsapp.com/g1');
  });

  it('records the learner email against the member', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.members.map((m) => m.email)).toEqual(['priya@example.com', 'arjun@example.com']);
  });
});

describe('importing the same sheet again', () => {
  it('creates nothing the second time', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);

    await teams.importLearnerAllocation(cohort.id, SHEET);
    const second = await teams.importLearnerAllocation(cohort.id, SHEET);

    expect(second.teamsCreated).toBe(0);
    expect(second.teamsMatched).toBe(2);
    expect(second.learnersAdded).toBe(0);
    expect(second.learnersUnchanged).toBe(3);

    const stored = await teams.listTeams(cohort.id);
    expect(stored).toHaveLength(2);
    expect(stored.flatMap((t) => t.members)).toHaveLength(3);
  });

  it('is still idempotent after a third run', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    for (let i = 0; i < 3; i += 1) await teams.importLearnerAllocation(cohort.id, SHEET);

    const stored = await teams.listTeams(cohort.id);
    expect(stored.flatMap((t) => t.members)).toHaveLength(3);
  });
});

describe('importing a corrected sheet', () => {
  it('adds the late joiners without disturbing anyone', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const corrected = [
      group(1, [
        ['Priya Sharma', 'priya@example.com'],
        ['Arjun Rao', 'arjun@example.com'],
        ['Late Joiner', 'late@example.com'],
      ]),
      SHEET[1]!,
    ];
    const result = await teams.importLearnerAllocation(cohort.id, corrected);

    expect(result.learnersAdded).toBe(1);
    expect(result.teamsCreated).toBe(0);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.members.map((m) => m.fullName)).toEqual([
      'Priya Sharma',
      'Arjun Rao',
      'Late Joiner',
    ]);
  });

  it('fixes a misspelled name in place instead of adding a second person', async () => {
    // Matching on name would make "Priya Shrama" → "Priya Sharma" look like a
    // new learner, leaving the team with a phantom member.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Shrama', 'priya@example.com']]),
    ]);

    const result = await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Sharma', 'priya@example.com']]),
    ]);

    expect(result.learnersUpdated).toBe(1);
    expect(result.learnersAdded).toBe(0);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.members).toHaveLength(1);
    expect(team?.members[0]?.fullName).toBe('Priya Sharma');
  });

  it('treats a changed email case as the same person', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Sharma', 'priya@example.com']]),
    ]);

    const result = await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Sharma', 'Priya@Example.com']]),
    ]);

    expect(result.learnersAdded).toBe(0);
    expect(result.learnersUnchanged).toBe(1);
    const [team] = await teams.listTeams(cohort.id);
    expect(team?.members).toHaveLength(1);
  });

  it('adds a new group without touching the existing ones', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const result = await teams.importLearnerAllocation(cohort.id, [
      ...SHEET,
      group(3, [['New Person', 'new@example.com']]),
    ]);

    expect(result.teamsCreated).toBe(1);
    expect(result.teamsMatched).toBe(2);
    expect((await teams.listTeams(cohort.id)).map((t) => t.groupNumber)).toEqual([1, 2, 3]);
  });
});

describe('a learner missing from the new sheet', () => {
  const shorter = [group(1, [['Priya Sharma', 'priya@example.com']]), SHEET[1]!];

  it('is reported, not deleted', async () => {
    // A row deleted by accident and a learner who genuinely left look
    // identical. Removing them would destroy a real record on the strength of
    // a spreadsheet edit.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const result = await teams.importLearnerAllocation(cohort.id, shorter);

    expect(result.departed).toEqual([
      expect.objectContaining({ groupNumber: 1, name: 'Arjun Rao', email: 'arjun@example.com' }),
    ]);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.members).toHaveLength(2);
  });
});

describe('the WhatsApp link on re-import', () => {
  it('is not erased by a sheet with a blank Link column', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Sharma', 'priya@example.com']], null),
    ]);

    const [team] = await teams.listTeams(cohort.id);
    expect(team?.whatsappLink).toBe('https://chat.whatsapp.com/g1');
  });

  it('is replaced when a new link is supplied', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const result = await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Priya Sharma', 'priya@example.com']], 'https://chat.whatsapp.com/moved'),
    ]);

    expect(result.whatsappLinksSet).toBe(1);
    const [team] = await teams.listTeams(cohort.id);
    expect(team?.whatsappLink).toBe('https://chat.whatsapp.com/moved');
  });
});

describe('isolation between cohorts', () => {
  it('lets the same learner appear in a later cohort', async () => {
    // Learners take the programme more than once. A global email constraint
    // would lock them out the second time.
    const teams = buildTeamStore(db);
    const first = await makeCohort('AUG');
    const second = await makeCohort('SEP');

    await teams.importLearnerAllocation(first.id, SHEET);
    const result = await teams.importLearnerAllocation(second.id, SHEET);

    expect(result.teamsCreated).toBe(2);
    expect(result.learnersAdded).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('keeps group 1 of one cohort separate from group 1 of another', async () => {
    const teams = buildTeamStore(db);
    const first = await makeCohort('AUG');
    const second = await makeCohort('SEP');

    await teams.importLearnerAllocation(first.id, [group(1, [['A', 'a@example.com']])]);
    await teams.importLearnerAllocation(second.id, [group(1, [['B', 'b@example.com']])]);

    const firstTeams = await teams.listTeams(first.id);
    expect(firstTeams[0]?.members.map((m) => m.fullName)).toEqual(['A']);
  });
});

describe('a group that fails', () => {
  it('does not take the rest of the sheet with it', async () => {
    // 1,000 learners means a few bad rows every time. Rejecting the whole file
    // makes the operator re-upload and re-check everything under deadline.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);

    const result = await teams.importLearnerAllocation(cohort.id, [
      group(1, [['Fine', 'fine@example.com']]),
      group(9999, [['Out of range', 'oor@example.com']]), // violates the 1..999 check
      group(3, [['Also fine', 'also@example.com']]),
    ]);

    expect(result.failed.map((f) => f.groupNumber)).toEqual([9999]);
    expect(result.teamsCreated).toBe(2);
    expect((await teams.listTeams(cohort.id)).map((t) => t.groupNumber)).toEqual([1, 3]);
  });

  it('leaves no half-imported team behind', async () => {
    // Within a group the write is atomic: a team holding half its members
    // looks like it worked, which is worse than a reported failure.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);

    const result = await teams.importLearnerAllocation(cohort.id, [
      {
        groupNumber: 4,
        whatsappLink: null,
        // The same email twice violates the per-team unique index.
        learners: [
          { name: 'One', email: 'dup@example.com' },
          { name: 'Two', email: 'dup@example.com' },
        ],
      },
    ]);

    expect(result.failed).toHaveLength(1);
    expect(await teams.listTeams(cohort.id)).toEqual([]);
  });
});

describe('scale', () => {
  it('imports 100 groups of 5 learners', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);

    const sheet = Array.from({ length: 100 }, (_, g) =>
      group(
        g + 1,
        Array.from({ length: 5 }, (_, l) => [`Learner ${g}-${l}`, `l${g}-${l}@example.com`] as [string, string]),
      ),
    );

    const result = await teams.importLearnerAllocation(cohort.id, sheet);

    expect(result.teamsCreated).toBe(100);
    expect(result.learnersAdded).toBe(500);
    expect(result.failed).toEqual([]);
  }, 60_000);
});

describe('issuing access codes after an import', () => {
  it('gives every imported team a code', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const issued = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    expect(issued.map((r) => r.groupNumber).sort()).toEqual([1, 2]);
    expect(issued.every((r) => r.code.length > 0)).toBe(true);
  });

  it('carries the WhatsApp link and member count onto the sheet', async () => {
    // Distribution is manual. Without the destination beside the code, the
    // operator looks each one up separately across a hundred groups, which is
    // how a code reaches the wrong chat.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);

    const issued = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    const group1 = issued.find((r) => r.groupNumber === 1);

    expect(group1?.whatsappLink).toBe('https://chat.whatsapp.com/g1');
    expect(group1?.memberCount).toBe(2);
  });

  it('covers only the new teams after a second import', async () => {
    // The case the old design could not serve: a corrected sheet adds five
    // teams, and the only download available regenerated all ninety-five
    // codes that were already distributed.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);
    const first = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    await teams.importLearnerAllocation(cohort.id, [
      ...SHEET,
      group(3, [['Late Team', 'late@example.com']]),
    ]);
    const second = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    expect(first).toHaveLength(2);
    expect(second.map((r) => r.groupNumber)).toEqual([3]);
    expect(second[0]?.regenerated).toBe(false);
  });

  it('reports nothing to do when every team already holds one', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    expect(await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false })).toEqual([]);
  });

  it('replaces every code when rotation is explicit', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);
    const first = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    const rotated = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: true });

    expect(rotated).toHaveLength(2);
    expect(rotated.every((r) => r.regenerated)).toBe(true);
    // A new code is genuinely new, not the old one re-emitted.
    const before = new Set(first.map((r) => r.code));
    expect(rotated.some((r) => before.has(r.code))).toBe(false);
  });

  it('regenerates one team without touching the others', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importLearnerAllocation(cohort.id, SHEET);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    const stored = await teams.listTeams(cohort.id);
    const target = stored.find((t) => t.groupNumber === 1)!;
    const one = await teams.generateAccessCodes({
      cohortId: cohort.id,
      teamIds: [target.id],
      regenerate: true,
    });

    expect(one).toHaveLength(1);
    expect(one[0]?.groupNumber).toBe(1);

    const status = await teams.listAccessCodeStatus(cohort.id);
    expect(status.find((s) => s.groupNumber === 1)?.version).toBe(2);
    expect(status.find((s) => s.groupNumber === 2)?.version).toBe(1);
  });
});
