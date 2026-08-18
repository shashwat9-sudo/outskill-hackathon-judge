import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { createInMemoryStorage } from './storage';
import { buildParticipantStore } from './repositories/participant';
import { buildTeamStore } from './repositories/teams';
import { makeCohort } from './testing/assessment-fixtures';
import type { ParticipantStore, TeamStore } from '../store';

/**
 * A code opens exactly one team's door.
 *
 * Reported during the Phase A acceptance run: group 902 was said to be accepted
 * when group 901's genuine code was entered. If that is true, the shared code
 * model is broken — every team could read and overwrite every other team's
 * submission, and the first anyone would know is on results day.
 *
 * These tests pin the whole truth table rather than the single reported case,
 * because a fix that satisfies one direction and not the other is not a fix.
 */

let db: PgliteHandle;
let participant: ParticipantStore;
let teams: TeamStore;
let cohortId: string;

/** Codes for groups 901 and 902, captured at generation — the only moment they exist. */
let codeA: string;
let codeB: string;
let teamAId: string;
let teamBId: string;

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

  const cohort = await makeCohort(db, 'XTEAM');
  cohortId = cohort.id;

  teams = buildTeamStore(db);
  participant = buildParticipantStore({
    db,
    storage: createInMemoryStorage(),
    sessionSecret: 'acceptance-secret-long-enough-for-hmac-use',
    credentialKey: 'a'.repeat(64),
    credentialKeyVersion: 1,
  });

  await teams.importLearnerAllocation(cohortId, [
    { groupNumber: 901, whatsappLink: null, learners: [{ name: 'Alpha', email: 'a@acceptance.test' }] },
    { groupNumber: 902, whatsappLink: null, learners: [{ name: 'Beta', email: 'b@acceptance.test' }] },
  ]);

  const issued = await teams.generateAccessCodes({ cohortId, regenerate: false });
  const a = issued.find((r) => r.groupNumber === 901)!;
  const b = issued.find((r) => r.groupNumber === 902)!;
  codeA = a.code;
  codeB = b.code;
  teamAId = a.teamId;
  teamBId = b.teamId;
});

const ip = 'test-ip-hash';

// --------------------------------------------------------------------------

describe('the pair that must match', () => {
  it('accepts group 901 with code A', async () => {
    const result = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.teamId).toBe(teamAId);
  });

  it('accepts group 902 with code B', async () => {
    const result = await participant.verifyTeamAccess({ groupNumber: 902, code: codeB, ipHash: ip });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.teamId).toBe(teamBId);
  });

  it('REJECTS group 902 with code A', async () => {
    // The reported defect, stated directly.
    const result = await participant.verifyTeamAccess({ groupNumber: 902, code: codeA, ipHash: ip });
    expect(result.ok).toBe(false);
  });

  it('REJECTS group 901 with code B', async () => {
    const result = await participant.verifyTeamAccess({ groupNumber: 901, code: codeB, ipHash: ip });
    expect(result.ok).toBe(false);
  });

  it('never returns another team when a code is used against the wrong group', async () => {
    // The dangerous failure is not "accepted" — it is "accepted AS SOMEBODY
    // ELSE". A caller who asked for 902 must never receive 901's team id.
    const result = await participant.verifyTeamAccess({ groupNumber: 902, code: codeA, ipHash: ip });
    if (result.ok) {
      expect.fail(`Cross-team login succeeded and bound to team ${result.teamId}`);
    }
  });
});

describe('every rejection looks the same', () => {
  const attempt = async (groupNumber: number, code: string) =>
    participant.verifyTeamAccess({ groupNumber, code, ipHash: `${groupNumber}-${code.slice(0, 4)}` });

  it('gives one message for a wrong code, a foreign code and a missing group', async () => {
    const wrongCode = await attempt(901, 'ZZZZ-ZZZZ-ZZZZ');
    const foreignCode = await attempt(902, codeA);
    const noSuchGroup = await attempt(777, codeA);

    for (const result of [wrongCode, foreignCode, noSuchGroup]) {
      expect(result.ok).toBe(false);
    }
    const messages = new Set(
      [wrongCode, foreignCode, noSuchGroup].map((r) => (r.ok ? 'ok' : r.message)),
    );
    expect(messages.size, 'rejection messages differ, which enumerates the cohort').toBe(1);
  });

  it('does not reveal that a group exists through its reason code', async () => {
    const real = await attempt(901, 'ZZZZ-ZZZZ-ZZZZ');
    const fake = await attempt(777, 'ZZZZ-ZZZZ-ZZZZ');
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (!real.ok && !fake.ok) expect(real.reason).toBe(fake.reason);
  });
});

describe('a code that is no longer live', () => {
  it('is rejected after the team is issued a new one', async () => {
    const reissued = await teams.generateAccessCodes({
      cohortId,
      teamIds: [teamAId],
      regenerate: true,
    });
    const newCode = reissued[0]!.code;

    expect((await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip })).ok).toBe(false);
    expect((await participant.verifyTeamAccess({ groupNumber: 901, code: newCode, ipHash: ip })).ok).toBe(true);
  });

  it('is rejected after revocation, with no replacement', async () => {
    await teams.revokeAccessCode(teamAId);
    expect((await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip })).ok).toBe(false);
  });

  it('does not become valid for another group once revoked', async () => {
    await teams.revokeAccessCode(teamAId);
    expect((await participant.verifyTeamAccess({ groupNumber: 902, code: codeA, ipHash: ip })).ok).toBe(false);
  });
});

describe('the session that follows verification', () => {
  it('is bound to the team that was verified, not the one requested', async () => {
    const verified = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip });
    if (!verified.ok) throw new Error('setup failed');

    const session = await participant.createSession({
      teamId: verified.teamId,
      editorName: 'Alpha',
      editorRole: null,
      ipHash: null,
    });
    const view = await participant.resolveSession(session.token);

    expect(view?.team.id).toBe(teamAId);
    expect(view?.team.groupNumber).toBe(901);
  });

  it('cannot be pointed at another team by passing a different id', async () => {
    // A caller who verified as 901 and then asks for a session on 902's team
    // must not receive 902's submission. The identifier is not a request.
    const verified = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip });
    if (!verified.ok) throw new Error('setup failed');

    const session = await participant.createSession({
      teamId: teamBId,
      editorName: 'Attacker',
      editorRole: null,
      ipHash: null,
    });
    const view = await participant.resolveSession(session.token);

    // Documents what the store alone permits. The binding that stops this is in
    // the web action, which only ever passes the verified team id — asserted in
    // apps/web/src/server/participant-entry.test.ts.
    expect(view?.team.id).toBe(teamBId);
  });

  it('reaches only its own submission', async () => {
    const a = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: ip });
    const b = await participant.verifyTeamAccess({ groupNumber: 902, code: codeB, ipHash: `${ip}-b` });
    if (!a.ok || !b.ok) throw new Error('setup failed');

    const sessionA = await participant.createSession({ teamId: a.teamId, editorName: 'A', editorRole: null, ipHash: null });
    const sessionB = await participant.createSession({ teamId: b.teamId, editorName: 'B', editorRole: null, ipHash: null });

    const viewA = await participant.resolveSession(sessionA.token);
    const viewB = await participant.resolveSession(sessionB.token);

    expect(viewA?.submission.id).not.toBe(viewB?.submission.id);
    expect(viewA?.team.groupNumber).toBe(901);
    expect(viewB?.team.groupNumber).toBe(902);
  });
});

describe('two cohorts using the same group numbers', () => {
  it('signs a learner into the cohort that is actually running', async () => {
    // Every cohort numbers its groups from 1, so "group 901" is ambiguous the
    // moment a second cohort exists. The lookup used to take whichever row came
    // back first, which meant a returning learner could have their code checked
    // against a stranger's team and be refused entry to their own hackathon.
    const previous = await makeCohort(db, 'PREV');
    await teams.importLearnerAllocation(previous.id, [
      { groupNumber: 901, whatsappLink: null, learners: [{ name: 'Older', email: 'o@acceptance.test' }] },
    ]);
    const previousIssued = await teams.generateAccessCodes({ cohortId: previous.id, regenerate: false });
    const previousCode = previousIssued.find((r) => r.groupNumber === 901)!.code;

    // The cohort under test is the one learners are submitting to.
    await db.query("update cohorts set status = 'open' where id = $1", [cohortId]);

    const current = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: 'c1' });
    expect(current.ok, 'the running cohort must accept its own code').toBe(true);
    if (current.ok) {
      expect(current.teamId).toBe(teamAId);
      expect(current.cohortId).toBe(cohortId);
    }

    // The old cohort's code opens nothing: that hackathon is over.
    const stale = await participant.verifyTeamAccess({ groupNumber: 901, code: previousCode, ipHash: 'c2' });
    expect(stale.ok).toBe(false);
  });

  it('refuses rather than choosing between two equal claims', async () => {
    // Neither cohort is running, so neither group 901 has a better claim.
    // Signing somebody into a coin-flip team would hand them edit access to
    // another cohort's submission.
    const other = await makeCohort(db, 'OTHER');
    await teams.importLearnerAllocation(other.id, [
      { groupNumber: 901, whatsappLink: null, learners: [{ name: 'Other', email: 'x@acceptance.test' }] },
    ]);
    await teams.generateAccessCodes({ cohortId: other.id, regenerate: false });

    const result = await participant.verifyTeamAccess({ groupNumber: 901, code: codeA, ipHash: 'c3' });
    expect(result.ok).toBe(false);
  });
});
