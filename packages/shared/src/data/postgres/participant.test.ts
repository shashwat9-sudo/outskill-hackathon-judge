import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildCohortStore } from './repositories/admin';
import { buildTeamStore } from './repositories/teams';
import { createInMemoryStorage } from './storage';
import { buildParticipantStore } from './repositories/participant';
import type { AssessmentConfig } from '../types';
import type { ParticipantStore } from '../store';

/**
 * The participant surface, against a real Postgres engine.
 *
 * These are the assertions that matter most in the system: a team getting into
 * another team's submission, or a revoked code still working, is the worst
 * failure this platform can have. TypeScript cannot check any of it.
 */

let db: PgliteHandle;
let participant: ParticipantStore;

const CREDENTIAL_KEY = randomBytes(32).toString('base64');
const SESSION_SECRET = 'test-session-secret';

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test', true)`,
  );
  participant = buildParticipantStore({
    db,
    storage: createInMemoryStorage(),
    sessionSecret: SESSION_SECRET,
    credentialKey: CREDENTIAL_KEY,
    credentialKeyVersion: 1,
  });
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

/** An open cohort with two teams, each holding a live access code. */
async function scenario() {
  const cohorts = buildCohortStore(db);
  const teams = buildTeamStore(db);

  const cohort = await cohorts.createCohort({
    name: 'Test cohort',
    code: 'TEST',
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date(Date.now() - 86_400_000),
    day13DeadlineAt: new Date(Date.now() + 86_400_000),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v2',
    assessmentConfig: CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
  await cohorts.setCohortStatus(cohort.id, 'open');

  await teams.importTeams(cohort.id, [
    { groupNumber: 12, leadName: 'Lead A', leadEmail: 'a@example.invalid', leadPhone: '' },
    { groupNumber: 27, leadName: 'Lead B', leadEmail: 'b@example.invalid', leadPhone: '' },
  ]);

  const codes = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
  const byGroup = new Map(codes.map((c) => [c.groupNumber, c]));
  return { cohort, cohorts, teams, codes, byGroup };
}

async function signIn(groupNumber: number, code: string, name = 'Priya') {
  const verified = await participant.verifyTeamAccess({
    groupNumber,
    code,
    ipHash: `ip-${groupNumber}`,
  });
  if (!verified.ok) throw new Error(`verification failed: ${verified.message}`);
  const session = await participant.createSession({
    teamId: verified.teamId,
    editorName: name,
    editorRole: null,
    ipHash: null,
  });
  return session.token;
}

// --------------------------------------------------------------------------

describe('verification', () => {
  it('accepts the right code for the right group', async () => {
    const { byGroup } = await scenario();
    const result = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: byGroup.get(12)!.code,
      ipHash: 'ip',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts the code however it was typed', async () => {
    const { byGroup } = await scenario();
    const code = byGroup.get(12)!.code; // already formatted ABCD-EFGH-JKMN
    for (const variant of [code.toLowerCase(), code.replace(/-/g, ''), ` ${code} `]) {
      const result = await participant.verifyTeamAccess({
        groupNumber: 12,
        code: variant,
        ipHash: `ip-${variant}`,
      });
      expect(result.ok, variant).toBe(true);
    }
  });

  it('gives an identical response for an unknown group and a wrong code', async () => {
    // If these differed, the form would be a cohort enumeration tool.
    const { byGroup } = await scenario();

    const wrongCode = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: 'QQQQ-QQQQ-QQQQ',
      ipHash: 'ip-a',
    });
    const unknownGroup = await participant.verifyTeamAccess({
      groupNumber: 999,
      code: byGroup.get(12)!.code,
      ipHash: 'ip-b',
    });

    expect(wrongCode).toEqual(unknownGroup);
    expect(wrongCode.ok).toBe(false);
  });

  it('gives that same response for a team with no code and for a revoked one', async () => {
    const { cohort, teams, byGroup } = await scenario();
    const baseline = await participant.verifyTeamAccess({
      groupNumber: 999,
      code: 'QQQQ-QQQQ-QQQQ',
      ipHash: 'ip-base',
    });

    const status = await teams.listAccessCodeStatus(cohort.id);
    await teams.revokeAccessCode(status.find((s) => s.groupNumber === 12)!.teamId);

    const revoked = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: byGroup.get(12)!.code,
      ipHash: 'ip-rev',
    });
    expect(revoked).toEqual(baseline);
  });

  it('refuses a withdrawn team even with the correct code', async () => {
    const { cohort, byGroup } = await scenario();
    await db.query("update teams set status = 'withdrawn' where group_number = 12 and cohort_id = $1", [
      cohort.id,
    ]);

    const result = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: byGroup.get(12)!.code,
      ipHash: 'ip',
    });
    expect(result.ok).toBe(false);
  });

  it('never stores plaintext anywhere', async () => {
    const { byGroup } = await scenario();
    const plaintext = byGroup.get(12)!.code.replace(/-/g, '');

    // Every text-ish column in the access-code table, searched for the code.
    const { rows } = await db.query<{ hit: number }>(
      `select count(*)::int as hit from team_access_codes
        where code_hash like '%' || $1 || '%'`,
      [plaintext],
    );
    expect(rows[0]?.hit).toBe(0);

    const stored = await db.query<{ code_hash: string }>('select code_hash from team_access_codes');
    for (const row of stored.rows) expect(row.code_hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('locks out after eight failures and reports how long to wait', async () => {
    await scenario();
    for (let i = 0; i < 8; i++) {
      const result = await participant.verifyTeamAccess({
        groupNumber: 12,
        code: 'QQQQ-QQQQ-QQQQ',
        ipHash: 'attacker',
      });
      expect(result.ok, `attempt ${i + 1}`).toBe(false);
    }

    const blocked = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: 'QQQQ-QQQQ-QQQQ',
      ipHash: 'attacker',
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.reason).toBe('rate_limited');
  });

  it('does not let one client lock out the whole team', async () => {
    // Keyed on hashed IP AND group, so a hostile client cannot deny a team
    // access from somewhere else.
    const { byGroup } = await scenario();
    for (let i = 0; i < 8; i++) {
      await participant.verifyTeamAccess({
        groupNumber: 12,
        code: 'QQQQ-QQQQ-QQQQ',
        ipHash: 'attacker',
      });
    }

    const legitimate = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: byGroup.get(12)!.code,
      ipHash: 'the-actual-team',
    });
    expect(legitimate.ok).toBe(true);
  });

  it('clears the counter on success, so a fumbling team is not left one from a lockout', async () => {
    const { byGroup } = await scenario();
    for (let i = 0; i < 5; i++) {
      await participant.verifyTeamAccess({ groupNumber: 12, code: 'QQQQ-QQQQ-QQQQ', ipHash: 'ip' });
    }
    await participant.verifyTeamAccess({ groupNumber: 12, code: byGroup.get(12)!.code, ipHash: 'ip' });

    const { rows } = await db.query<{ attempts: number }>(
      'select attempts from verification_attempts where ip_hash = $1',
      ['ip'],
    );
    expect(rows[0]?.attempts).toBe(0);
  });

  it('is cleared by an admin so a locked-out team can try again immediately', async () => {
    const { cohort, teams } = await scenario();
    for (let i = 0; i < 8; i++) {
      await participant.verifyTeamAccess({ groupNumber: 12, code: 'WRONG-WRONG-WRNG', ipHash: 'ip' });
    }
    await teams.clearVerificationLockout(cohort.id, 12);

    const after = await participant.verifyTeamAccess({
      groupNumber: 12,
      code: 'QQQQ-QQQQ-QQQQ',
      ipHash: 'ip',
    });
    if (after.ok) throw new Error('unreachable');
    // Allowed to try again — it fails on the wrong code, not on the lockout.
    expect(after.reason).toBe('invalid');
  });
});

describe('sessions', () => {
  it('resolves to exactly one team', async () => {
    const { byGroup } = await scenario();
    const tokenA = await signIn(12, byGroup.get(12)!.code, 'Priya');
    const tokenB = await signIn(27, byGroup.get(27)!.code, 'Arjun');

    const viewA = await participant.resolveSession(tokenA);
    const viewB = await participant.resolveSession(tokenB);

    expect(viewA?.team.groupNumber).toBe(12);
    expect(viewB?.team.groupNumber).toBe(27);
    expect(viewA?.submission.id).not.toBe(viewB?.submission.id);
  });

  it('cannot be minted for a team with no live access code', async () => {
    const { cohort, teams } = await scenario();
    const status = await teams.listAccessCodeStatus(cohort.id);
    const teamId = status[0]!.teamId;
    await teams.revokeAccessCode(teamId);

    await expect(
      participant.createSession({ teamId, editorName: 'X', editorRole: null, ipHash: null }),
    ).rejects.toThrow(/no live access code|withdrawn/i);
  });

  it('stops working the moment the access code is regenerated', async () => {
    const { cohort, teams, byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    expect(await participant.resolveSession(token)).not.toBeNull();

    const status = await teams.listAccessCodeStatus(cohort.id);
    await teams.generateAccessCodes({
      cohortId: cohort.id,
      teamIds: [status.find((s) => s.groupNumber === 12)!.teamId],
      regenerate: true,
    });

    expect(await participant.resolveSession(token)).toBeNull();
  });

  it('stops working when the code is revoked', async () => {
    const { cohort, teams, byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const status = await teams.listAccessCodeStatus(cohort.id);
    await teams.revokeAccessCode(status.find((s) => s.groupNumber === 12)!.teamId);

    expect(await participant.resolveSession(token)).toBeNull();
  });

  it('expires', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    await db.query("update participant_sessions set expires_at = now() - interval '1 hour'");
    expect(await participant.resolveSession(token)).toBeNull();
  });

  it('signs out only this browser, not the rest of the team', async () => {
    const { byGroup } = await scenario();
    const code = byGroup.get(12)!.code;
    const first = await signIn(12, code, 'Priya');
    const second = await signIn(12, code, 'Arjun');

    await participant.endSession(first);

    expect(await participant.resolveSession(first)).toBeNull();
    expect((await participant.resolveSession(second))?.editorName).toBe('Arjun');
  });

  it('rejects an invented token', async () => {
    await scenario();
    expect(await participant.resolveSession('not-a-real-token')).toBeNull();
    expect(await participant.resolveSession('')).toBeNull();
  });

  it('stores only a hash of the token', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from participant_sessions where session_token_hash = $1',
      [token],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('carries the editor name as a label, and lets a second member use another', async () => {
    // Anyone with the shared code can type any name. Nothing security-relevant
    // depends on it (ADR-029).
    const { byGroup } = await scenario();
    const code = byGroup.get(12)!.code;
    const a = await signIn(12, code, 'Priya Raman');
    const b = await signIn(12, code, 'Arjun Mehta');

    expect((await participant.resolveSession(a))?.editorName).toBe('Priya Raman');
    expect((await participant.resolveSession(b))?.editorName).toBe('Arjun Mehta');
  });
});

describe('participant isolation', () => {
  it('exposes no score, rank, evidence or shortlist in the view', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const view = await participant.resolveSession(token);

    const serialised = JSON.stringify(view).toLowerCase();
    for (const forbidden of ['score', 'rank', 'shortlist', 'finalist', 'evidence', 'disqualif']) {
      expect(serialised, `view contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('has no method that reaches an assessment table', async () => {
    // The capability is absent rather than guarded (ADR-010).
    const names = Object.keys(participant);
    for (const forbidden of ['scores', 'ranking', 'evidence', 'shortlist', 'finalists']) {
      expect(names.join(' ').toLowerCase()).not.toContain(forbidden);
    }
  });

  it('cannot remove another team’s artifact', async () => {
    const { byGroup } = await scenario();
    const tokenA = await signIn(12, byGroup.get(12)!.code);
    const tokenB = await signIn(27, byGroup.get(27)!.code);

    const artifact = await participant.attachArtifact(tokenA, {
      kind: 'demo_video',
      storageBucket: null,
      storagePath: null,
      originalFilename: null,
      mimeType: null,
      byteSize: null,
      checksumSha256: null,
      externalUrl: 'https://example.invalid/video',
      uploadCompletedAt: new Date(),
      isAccessible: null,
      lastCheckedAt: null,
    });
    expect(artifact).not.toBeNull();

    // Team B tries to delete team A's artifact by id.
    await participant.removeArtifact(tokenB, artifact!.id);

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from submission_artifacts where id = $1',
      [artifact!.id],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('drafts and optimistic concurrency', () => {
  it('saves a draft and promotes it to the judged columns', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const view = await participant.resolveSession(token);

    const result = await participant.saveDraft(
      token,
      { product: { productName: 'ShiftLoop' }, live: { productUrl: 'https://example.invalid' } },
      view!.submission.version,
    );

    expect(result.ok).toBe(true);
    expect(result.submission?.productName).toBe('ShiftLoop');
    expect(result.submission?.productUrl).toBe('https://example.invalid');
    expect(result.submission?.version).toBe(view!.submission.version + 1);
  });

  it('records who last edited', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code, 'Priya');
    const view = await participant.resolveSession(token);
    const result = await participant.saveDraft(token, { product: {} }, view!.submission.version);
    expect(result.submission?.lastEditedBy).toBe('Priya');
  });

  it('refuses a stale write and keeps the winner’s data intact', async () => {
    // A and B both load version N. A saves. B must be refused, and A's data
    // must survive.
    const { byGroup } = await scenario();
    const code = byGroup.get(12)!.code;
    const tokenA = await signIn(12, code, 'A');
    const tokenB = await signIn(12, code, 'B');

    const readA = await participant.resolveSession(tokenA);
    const readB = await participant.resolveSession(tokenB);
    const version = readA!.submission.version;
    expect(readB!.submission.version).toBe(version);

    const saveA = await participant.saveDraft(
      tokenA,
      { product: { productName: 'A wrote this' } },
      version,
    );
    expect(saveA.ok).toBe(true);

    const saveB = await participant.saveDraft(
      tokenB,
      { product: { productName: 'B would have clobbered it' } },
      version,
    );
    expect(saveB.ok).toBe(false);
    expect(saveB.conflict?.currentVersion).toBe(version + 1);
    expect(saveB.conflict?.message).toMatch(/another team member/i);

    const after = await participant.resolveSession(tokenA);
    expect(after!.submission.productName).toBe('A wrote this');
  });

  it('refuses an unversioned write', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const result = await participant.saveDraft(token, { product: {} }, -1);
    expect(result.ok).toBe(false);
  });

  it('refuses every write once the cohort is closed', async () => {
    const { cohort, cohorts, byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const view = await participant.resolveSession(token);
    await cohorts.closeSubmissions(cohort.id, 'manual');

    const result = await participant.saveDraft(token, { product: {} }, view!.submission.version);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/closed/i);
  });

  it('refuses a write once the deadline has passed, with the status still open', async () => {
    // The load-bearing case: acceptance is decided from the server clock on
    // every write, not by a scheduler having run.
    const { cohort, byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    const view = await participant.resolveSession(token);
    await db.query("update cohorts set day13_deadline_at = now() - interval '1 hour' where id = $1", [
      cohort.id,
    ]);

    const result = await participant.saveDraft(token, { product: {} }, view!.submission.version);
    expect(result.ok).toBe(false);

    const { rows } = await db.query<{ status: string }>('select status from cohorts where id = $1', [
      cohort.id,
    ]);
    expect(rows[0]?.status).toBe('open');
  });

  it('records learner-safe activity and nothing else', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code, 'Priya');
    await participant.recordActivity(token, 'section_saved', 'Product overview');

    const view = await participant.resolveSession(token);
    expect(view?.recentActivity[0]?.kind).toBe('section_saved');
    expect(view?.recentActivity[0]?.editorName).toBe('Priya');
    expect(view?.recentActivity[0]?.section).toBe('Product overview');
  });
});

describe('credentials', () => {
  it('stores ciphertext, never the plaintext', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    await participant.storeCredentials(token, {
      username: 'judge@demo.invalid',
      password: 'DemoReviewer!2026',
    });

    const { rows } = await db.query<{ u: Buffer | null; p: Buffer | null }>(
      'select username_ciphertext as u, password_ciphertext as p from submission_credentials',
    );
    const blob = `${rows[0]?.u?.toString('utf8')}${rows[0]?.p?.toString('utf8')}`;
    expect(blob).not.toContain('DemoReviewer!2026');
    expect(blob).not.toContain('judge@demo.invalid');
  });

  it('reports presence to the participant without the values', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    expect((await participant.resolveSession(token))?.hasStoredCredentials).toBe(false);

    await participant.storeCredentials(token, { username: 'u', password: 'p' });
    const view = await participant.resolveSession(token);
    expect(view?.hasStoredCredentials).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"p"');
  });

  it('gives each field its own IV, so GCM is not broken by reuse', async () => {
    const { byGroup } = await scenario();
    const token = await signIn(12, byGroup.get(12)!.code);
    await participant.storeCredentials(token, { username: 'same', password: 'same' });

    const { rows } = await db.query<{ u: Buffer; p: Buffer }>(
      'select username_ciphertext as u, password_ciphertext as p from submission_credentials',
    );
    // Identical plaintexts must not produce identical ciphertexts.
    expect(rows[0]!.u.toString('utf8')).not.toBe(rows[0]!.p.toString('utf8'));
  });
});
