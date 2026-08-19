import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAdminAuthStore, buildCohortStore } from './repositories/admin';
import { buildTeamStore } from './repositories/teams';
import { buildAuditStore, buildResourceStore, buildSettingsStore } from './repositories/support';
import { createInMemoryStorage } from './storage';
import { verifyAccessCode } from '../../security/access-code';
import type { AssessmentConfig } from '../types';

/**
 * Postgres driver, against a real Postgres engine.
 *
 * PGlite runs the actual migration files, so these tests exercise the same
 * schema that is deployed — a column name this driver gets wrong fails here.
 *
 * The assertions are about behaviour the application depends on, not about SQL
 * having executed: that a regenerated access code signs teammates out, that an
 * idea edit un-approves its definition, that an import survives a bad row.
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
  await seedRubric();
});

/** Cohorts need a rubric version to point at. */
async function seedRubric(): Promise<void> {
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test rubric', true)`,
  );
}

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

async function makeCohort(code = 'TEST') {
  return buildCohortStore(db).createCohort({
    name: `Cohort ${code}`,
    code,
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date('2026-03-12T03:30:00Z'),
    day13DeadlineAt: new Date('2026-03-13T18:29:00Z'),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v2',
    assessmentConfig: CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
}

// --------------------------------------------------------------------------

describe('the schema this driver was written against', () => {
  it('is the real one', async () => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public'",
    );
    expect(rows[0]?.n).toBe(38);
  });

  it('has row-level security on every table', async () => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public' and not rowsecurity",
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('transactions', () => {
  it('rolls back every statement when one fails', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into rubric_versions (version, name, is_active) values ('rollback-me', 'x', false)`,
        );
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from rubric_versions where version = 'rollback-me'",
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('settings', () => {
  it('round-trips a structured value', async () => {
    const settings = buildSettingsStore(db);
    await settings.set('judging.config', { topN: 20, enabled: true }, 'shared-admin');
    expect(await settings.get('judging.config')).toEqual({ topN: 20, enabled: true });
  });

  it('overwrites rather than duplicating', async () => {
    const settings = buildSettingsStore(db);
    await settings.set('k', 1, 'a');
    await settings.set('k', 2, 'b');
    expect(await settings.get('k')).toBe(2);
    expect((await settings.getAll()).filter((s) => s.key === 'k')).toHaveLength(1);
  });

  it('returns null for a key that was never set', async () => {
    expect(await buildSettingsStore(db).get('never.written')).toBeNull();
  });
});

describe('audit log', () => {
  it('records an entry and reads it back', async () => {
    const audit = buildAuditStore(db);
    const cohort = await makeCohort();

    await audit.record({
      actorType: 'shared-admin',
      actorRef: 'admin',
      action: 'cohort.created',
      entityType: 'cohort',
      entityId: cohort.id,
      cohortId: cohort.id,
      before: null,
      after: { name: cohort.name },
      ipHash: null,
      userAgentHash: null,
    });

    const entries = await audit.list({ cohortId: cohort.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('cohort.created');
    expect(entries[0]?.after).toEqual({ name: cohort.name });
  });

  it('cannot be edited or deleted, even by this driver', async () => {
    // 0001 puts a trigger on audit_logs that rejects UPDATE and DELETE. A
    // shared admin account is only accountable if its trail is append-only.
    const cohort = await makeCohort();
    await buildAuditStore(db).record({
      actorType: 'shared-admin',
      actorRef: 'admin',
      action: 'x',
      entityType: 'cohort',
      entityId: cohort.id,
      cohortId: cohort.id,
      before: null,
      after: null,
      ipHash: null,
      userAgentHash: null,
    });

    await expect(db.query("update audit_logs set action = 'tampered'")).rejects.toThrow();
    await expect(db.query('delete from audit_logs')).rejects.toThrow();
  });
});

describe('admin account', () => {
  it('is idempotent to create, so a restart cannot reset the password', async () => {
    const auth = buildAdminAuthStore(db);
    const first = await auth.createAdminAccount('ops', 'hash-one');
    const second = await auth.createAdminAccount('someone-else', 'hash-two');

    expect(second.id).toBe(first.id);
    expect(second.username).toBe('ops');
    expect(second.passwordHash).toBe('hash-one');
  });

  it('revokes every session when credentials are rotated', async () => {
    const auth = buildAdminAuthStore(db);
    await auth.createAdminAccount('ops', 'hash-one');
    await auth.createSession({
      sessionTokenHash: 'session-a',
      csrfToken: 'csrf-a',
      expiresAt: new Date(Date.now() + 3_600_000),
      rotatedFrom: null,
      ipHash: null,
      userAgentHash: null,
    });

    await auth.rotateCredentials({ passwordHash: 'hash-two' });

    const session = await auth.getSessionByHash('session-a');
    expect(session?.revokedAt).not.toBeNull();
  });
});

describe('cohorts', () => {
  it('resolves the rubric version string rather than exposing the foreign key', async () => {
    const cohort = await makeCohort();
    expect(cohort.rubricVersion).toBe('rubric-v2');
    expect(cohort).not.toHaveProperty('rubricVersionId');
  });

  it('refuses a cohort pointing at a rubric that does not exist', async () => {
    await expect(
      buildCohortStore(db).createCohort({
        ...(await makeCohort('OTHER')),
        code: 'NOPE',
        rubricVersion: 'rubric-does-not-exist',
      }),
    ).rejects.toThrow(/Rubric version/);
  });

  it('stores and reads the assessment config as structured data', async () => {
    const cohort = await makeCohort();
    const read = await buildCohortStore(db).getCohort(cohort.id);
    expect(read?.assessmentConfig.browserBudgetMs).toBe(480_000);
  });

  it('closes and clears any extension, because a closure supersedes one', async () => {
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort();
    await cohorts.reopenSubmissions(cohort.id, {
      reason: 'test',
      acceptingUntil: new Date('2026-03-14T06:00:00Z'),
    });

    const closed = await cohorts.closeSubmissions(cohort.id, 'manual');
    expect(closed.status).toBe('closed');
    expect(closed.closureType).toBe('manual');
    expect(closed.acceptingUntil).toBeNull();
    expect(closed.closedAt).not.toBeNull();
  });

  it('closes an open cohort whose deadline has passed', async () => {
    const cohorts = buildCohortStore(db);
    const past = await makeCohort('PAST');
    await cohorts.setCohortStatus(past.id, 'open');

    const { closed } = await cohorts.reconcileDeadlines(new Date('2026-03-14T00:00:00Z'));
    expect(closed).toEqual([past.id]);
  });

  it('leaves an open cohort whose deadline has not passed', async () => {
    // Separate case rather than two open cohorts at once, which the
    // exclusivity invariant now correctly refuses.
    const cohorts = buildCohortStore(db);
    const future = await makeCohort('FUTR');
    await cohorts.updateCohort(future.id, { day13DeadlineAt: new Date('2099-01-01T00:00:00Z') });
    await cohorts.setCohortStatus(future.id, 'open');

    const { closed } = await cohorts.reconcileDeadlines(new Date('2026-03-14T00:00:00Z'));
    expect(closed).toEqual([]);
  });

  it('resolves the single open cohort as the active one', async () => {
    const cohorts = buildCohortStore(db);
    await makeCohort('DRFT');
    const open = await makeCohort('OPEN');
    await cohorts.setCohortStatus(open.id, 'open');

    expect((await cohorts.findActiveCohort())?.id).toBe(open.id);
  });
});

describe('idea definitions', () => {
  async function makeIdea() {
    const cohort = await makeCohort();
    const idea = await buildCohortStore(db).createIdea({
      cohortId: cohort.id,
      title: 'Recipe sharing',
      slug: 'recipe-sharing',
      description: 'From the approved catalogue.',
      targetUser: 'Home cooks',
      expectedUseCase: 'Share a recipe',
      minimumCoreFlow: ['create', 'share'],
      expectedEntities: ['recipe', 'user'],
      aiOpportunity: 'Suggest substitutions',
      allowedScope: 'One workflow',
      unsafeInterpretations: 'A social network',
      displayOrder: 1,
      isActive: true,
      definitionStatus: 'draft',
      definitionApprovedAt: null,
      definitionApprovedBy: null,
    });
    return { cohort, idea };
  }

  it('round-trips array and jsonb fields', async () => {
    const { idea } = await makeIdea();
    expect(idea.minimumCoreFlow).toEqual(['create', 'share']);
    expect(idea.expectedEntities).toEqual(['recipe', 'user']);
  });

  it('records who approved a definition and when', async () => {
    const { idea } = await makeIdea();
    const approved = await buildCohortStore(db).approveIdeaDefinition(idea.id, 'shared-admin');
    expect(approved.definitionStatus).toBe('approved');
    expect(approved.definitionApprovedBy).toBe('shared-admin');
    expect(approved.definitionApprovedAt).not.toBeNull();
  });

  it('un-approves a definition when an expanded field is edited', async () => {
    // An approval that survives an edit is worse than no approval, because it
    // looks reviewed (ADR-025).
    const cohorts = buildCohortStore(db);
    const { idea } = await makeIdea();
    await cohorts.approveIdeaDefinition(idea.id, 'shared-admin');

    const edited = await cohorts.updateIdea(idea.id, { aiOpportunity: 'Something else entirely' });
    expect(edited.definitionStatus).toBe('draft');
    expect(edited.definitionApprovedAt).toBeNull();
  });

  it('keeps approval when only the sourced title changes', async () => {
    const cohorts = buildCohortStore(db);
    const { idea } = await makeIdea();
    await cohorts.approveIdeaDefinition(idea.id, 'shared-admin');

    const edited = await cohorts.updateIdea(idea.id, { title: 'Recipe sharing app' });
    expect(edited.definitionStatus).toBe('approved');
  });

  it('clones ideas as drafts, because the new operator has not read them', async () => {
    const cohorts = buildCohortStore(db);
    const { cohort, idea } = await makeIdea();
    await cohorts.approveIdeaDefinition(idea.id, 'shared-admin');

    const target = await makeCohort('NEXT');
    const cloned = await cohorts.cloneIdeas(cohort.id, target.id);

    expect(cloned).toHaveLength(1);
    expect(cloned[0]?.title).toBe('Recipe sharing');
    expect(cloned[0]?.definitionStatus).toBe('draft');
  });

  it('soft-deletes, so a submission that chose an idea can still resolve it', async () => {
    const cohorts = buildCohortStore(db);
    const { cohort, idea } = await makeIdea();
    await cohorts.deleteIdea(idea.id);

    expect(await cohorts.getIdea(idea.id)).not.toBeNull();
    expect(await cohorts.listIdeas(cohort.id)).toHaveLength(0);
    expect(await cohorts.listIdeas(cohort.id, { includeInactive: true })).toHaveLength(1);
  });
});

describe('team import', () => {
  it('imports a roster and issues an invite for each team', async () => {
    const cohort = await makeCohort();
    const result = await buildTeamStore(db).importTeams(cohort.id, [
      { groupNumber: 12, leadName: 'Lead A', leadEmail: 'a@example.invalid', leadPhone: '' },
      { groupNumber: 27, leadName: 'Lead B', leadEmail: 'b@example.invalid', leadPhone: '' },
    ]);

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.invites).toHaveLength(2);
    expect(new Set(result.invites.map((i) => i.token)).size).toBe(2);
  });

  it('skips a duplicate group without discarding the rest of the file', async () => {
    // A real roster always has a few problems. Re-uploading the whole file to
    // fix one line is worse than a report.
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    await teams.importTeams(cohort.id, [
      { groupNumber: 12, leadName: 'First', leadEmail: 'a@example.invalid', leadPhone: '' },
    ]);

    const result = await teams.importTeams(cohort.id, [
      { groupNumber: 12, leadName: 'Duplicate', leadEmail: 'c@example.invalid', leadPhone: '' },
      { groupNumber: 33, leadName: 'Fine', leadEmail: 'd@example.invalid', leadPhone: '' },
    ]);

    expect(result.created.map((t) => t.groupNumber)).toEqual([33]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/already exists/);
  });

  it('returns one live invite per team, not the superseded ones', async () => {
    const cohort = await makeCohort();
    const teams = buildTeamStore(db);
    const { created } = await teams.importTeams(cohort.id, [
      { groupNumber: 12, leadName: 'Lead', leadEmail: 'a@example.invalid', leadPhone: '' },
    ]);
    const teamId = created[0]!.id;

    await teams.generateInvite(teamId);
    await teams.generateInvite(teamId);

    const listed = await teams.listTeams(cohort.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.invite).not.toBeNull();
    expect(listed[0]?.invite?.revokedAt).toBeNull();
  });
});

describe('access codes', () => {
  async function cohortWithTeams() {
    const cohort = await makeCohort();
    await buildTeamStore(db).importTeams(cohort.id, [
      { groupNumber: 12, leadName: 'Lead A', leadEmail: 'a@example.invalid', leadPhone: '' },
      { groupNumber: 27, leadName: 'Lead B', leadEmail: 'b@example.invalid', leadPhone: '' },
    ]);
    return cohort;
  }

  it('issues a working code once, and stores only its hash', async () => {
    const cohort = await cohortWithTeams();
    const issued = await buildTeamStore(db).generateAccessCodes({
      cohortId: cohort.id,
      regenerate: false,
    });

    expect(issued).toHaveLength(2);

    const { rows } = await db.query<{ code_hash: string }>('select code_hash from team_access_codes');
    for (const row of rows) expect(row.code_hash.startsWith('$argon2id$')).toBe(true);

    // The returned plaintext verifies against what was stored — and it is the
    // only time that plaintext exists.
    const first = issued[0]!;
    const stored = await db.query<{ code_hash: string }>(
      'select code_hash from team_access_codes where team_id = $1',
      [first.teamId],
    );
    expect(await verifyAccessCode(first.code, stored.rows[0]!.code_hash)).toBe(true);
  });

  it('does not disturb teams that already hold a code', async () => {
    const cohort = await cohortWithTeams();
    const teams = buildTeamStore(db);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    const again = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    expect(again).toHaveLength(0);
  });

  it('bumps the version and signs teammates out when regenerating', async () => {
    const cohort = await cohortWithTeams();
    const teams = buildTeamStore(db);
    const [first] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    await db.query(
      `insert into participant_sessions
         (team_id, cohort_id, session_token_hash, editor_name, access_code_version, expires_at)
       values ($1, $2, 'hash', 'Priya', 1, now() + interval '1 day')`,
      [first!.teamId, cohort.id],
    );

    const regenerated = await teams.generateAccessCodes({
      cohortId: cohort.id,
      teamIds: [first!.teamId],
      regenerate: true,
    });

    expect(regenerated[0]?.regenerated).toBe(true);
    expect(regenerated[0]?.code).not.toBe(first!.code);

    const status = await teams.listAccessCodeStatus(cohort.id);
    const row = status.find((s) => s.teamId === first!.teamId);
    expect(row?.version).toBe(2);
    expect(row?.activeSessions).toBe(0);

    const sessions = await db.query<{ revoked_at: Date | null }>(
      'select revoked_at from participant_sessions where team_id = $1',
      [first!.teamId],
    );
    expect(sessions.rows[0]?.revoked_at).not.toBeNull();
  });

  it('leaves exactly one live code per team after regeneration', async () => {
    const cohort = await cohortWithTeams();
    const teams = buildTeamStore(db);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: true });

    // Enforced by a partial unique index in 0004, so this is the schema being
    // tested as much as the driver.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from team_access_codes where revoked_at is null`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('reports which teams are still waiting for a code', async () => {
    const cohort = await cohortWithTeams();
    const status = await buildTeamStore(db).listAccessCodeStatus(cohort.id);
    expect(status).toHaveLength(2);
    expect(status.every((s) => !s.hasCode)).toBe(true);
    expect(status.every((s) => s.version === 0)).toBe(true);
  });

  it('signs everyone out when a code is revoked', async () => {
    const cohort = await cohortWithTeams();
    const teams = buildTeamStore(db);
    const [first] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    await teams.revokeAccessCode(first!.teamId);
    const status = await teams.listAccessCodeStatus(cohort.id);
    expect(status.find((s) => s.teamId === first!.teamId)?.hasCode).toBe(false);
  });

  it('clears a lockout so a team can try again immediately', async () => {
    const cohort = await cohortWithTeams();
    await db.query(
      `insert into verification_attempts (cohort_id, group_number, ip_hash, attempts, locked_until)
       values ($1, 12, 'ip', 8, now() + interval '15 minutes')`,
      [cohort.id],
    );

    await buildTeamStore(db).clearVerificationLockout(cohort.id, 12);

    const { rows } = await db.query<{ attempts: number; locked_until: Date | null }>(
      'select attempts, locked_until from verification_attempts where cohort_id = $1',
      [cohort.id],
    );
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.locked_until).toBeNull();
  });
});

describe('resources', () => {
  it('lists cohort resources alongside the global ones', async () => {
    const cohort = await makeCohort();
    const resources = buildResourceStore(db, createInMemoryStorage());

    await resources.createResource({
      cohortId: null,
      kind: 'instructions',
      title: 'Global guide',
      description: '',
      storageBucket: 'admin-resources',
      storagePath: 'global.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
      isParticipantVisible: true,
      displayOrder: 1,
    });
    await resources.createResource({
      cohortId: cohort.id,
      kind: 'pitch_template',
      title: 'Cohort template',
      description: '',
      storageBucket: 'admin-resources',
      storagePath: 'template.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
      isParticipantVisible: true,
      displayOrder: 2,
    });

    const listed = await resources.listResources(cohort.id);
    expect(listed.map((r) => r.title)).toEqual(['Global guide', 'Cohort template']);
  });

  it('refuses to sign a URL for a bucket the application does not own', async () => {
    const resources = buildResourceStore(db, createInMemoryStorage());
    await expect(resources.getSignedUrl('some-other-bucket', 'x.pdf')).rejects.toThrow(
      /Unknown storage bucket/,
    );
  });
});

describe('cohort exclusivity, enforced by the store', () => {
  it('refuses to open a second cohort while one is already open', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(first.id, 'open');

    await expect(cohorts.setCohortStatus(second.id, 'open')).rejects.toThrow(
      /already open|is already/i,
    );
  });

  it('names the blocking cohort in the error', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(first.id, 'open');

    await expect(cohorts.setCohortStatus(second.id, 'open')).rejects.toThrow(/ONE/);
  });

  it('allows the second once the first is closed', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(first.id, 'open');
    await cohorts.closeSubmissions(first.id, 'manual');

    const opened = await cohorts.setCohortStatus(second.id, 'open');
    expect(opened.status).toBe('open');
  });

  it('refuses while the other is merely paused', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(first.id, 'open');
    await cohorts.setCohortStatus(first.id, 'paused');

    await expect(cohorts.setCohortStatus(second.id, 'open')).rejects.toThrow();
  });

  it('refuses a reopen that would create a second open cohort', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(second.id, 'open');
    await cohorts.closeSubmissions(second.id, 'manual');
    await cohorts.setCohortStatus(first.id, 'open');

    await expect(
      cohorts.reopenSubmissions(second.id, { reason: 'exception' }),
    ).rejects.toThrow(/already open|is already/i);
  });

  it('lets a paused cohort resume, because it is not blocking itself', async () => {
    const cohorts = buildCohortStore(db);
    const only = await makeCohort('ONE');
    await cohorts.setCohortStatus(only.id, 'open');
    await cohorts.setCohortStatus(only.id, 'paused');

    expect((await cohorts.setCohortStatus(only.id, 'open')).status).toBe('open');
  });

  it('lists learner-facing cohorts so the admin can see the state', async () => {
    const cohorts = buildCohortStore(db);
    const open = await makeCohort('ONE');
    await makeCohort('TWO');
    await cohorts.setCohortStatus(open.id, 'open');

    const facing = await cohorts.listLearnerFacingCohorts();
    expect(facing).toHaveLength(1);
    expect(facing[0]?.code).toBe('ONE');
  });
});

describe('archiving a cohort', () => {
  it('preserves everything and only changes the status', async () => {
    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);
    const cohort = await makeCohort('KEEP');
    await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    const archived = await cohorts.archiveCohort(cohort.id, 'shared-admin');
    expect(archived.status).toBe('archived');

    // Everything is still there.
    expect(await teams.listTeams(cohort.id)).toHaveLength(1);
    expect(await teams.listAccessCodeStatus(cohort.id)).toHaveLength(1);
    expect(await cohorts.getCohort(cohort.id)).not.toBeNull();
  });

  it('ends learner access rather than letting sessions run out', async () => {
    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);
    const cohort = await makeCohort('KEEP');
    await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    const [code] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    await db.query(
      `insert into participant_sessions
         (team_id, cohort_id, session_token_hash, editor_name, access_code_version, expires_at)
       values ($1, $2, 'hash', 'Priya', 1, now() + interval '1 day')`,
      [code!.teamId, cohort.id],
    );

    await cohorts.archiveCohort(cohort.id, 'shared-admin');

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from participant_sessions where revoked_at is null',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('frees the learner-facing slot', async () => {
    const cohorts = buildCohortStore(db);
    const first = await makeCohort('ONE');
    const second = await makeCohort('TWO');
    await cohorts.setCohortStatus(first.id, 'open');
    await cohorts.archiveCohort(first.id, 'shared-admin');

    expect((await cohorts.setCohortStatus(second.id, 'open')).status).toBe('open');
  });

  it('records who archived it', async () => {
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort('KEEP');
    await cohorts.archiveCohort(cohort.id, 'shared-admin');

    const entries = await buildAuditStore(db).list({ cohortId: cohort.id });
    expect(entries.some((e) => e.action === 'cohort.archived')).toBe(true);
  });
});

describe('permanent deletion', () => {
  it('is allowed for a cohort nobody has used', async () => {
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort('EMPTY');

    const result = await cohorts.deleteCohortPermanently(cohort.id, {
      confirmationPhrase: cohort.name,
      actor: 'shared-admin',
    });
    expect(result.deleted).toBe(true);
    expect(await cohorts.getCohort(cohort.id)).toBeNull();
  });

  it('is refused once a team has signed in', async () => {
    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);
    const cohort = await makeCohort('USED');
    await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    const [code] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    await db.query(
      `insert into participant_sessions
         (team_id, cohort_id, session_token_hash, editor_name, access_code_version, expires_at)
       values ($1, $2, 'h', 'Priya', 1, now() + interval '1 day')`,
      [code!.teamId, cohort.id],
    );

    await expect(
      cohorts.deleteCohortPermanently(cohort.id, {
        confirmationPhrase: cohort.name,
        actor: 'shared-admin',
      }),
    ).rejects.toThrow(/Archive it instead/i);
    expect(await cohorts.getCohort(cohort.id)).not.toBeNull();
  });

  it('is refused when a submission exists, even an empty draft', async () => {
    // A draft is work in progress, not scratch data.
    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);
    const cohort = await makeCohort('DRAFT');
    const { created } = await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    await db.query(
      `insert into submissions (cohort_id, team_id, status) values ($1, $2, 'draft')`,
      [cohort.id, created[0]!.id],
    );

    await expect(
      cohorts.deleteCohortPermanently(cohort.id, {
        confirmationPhrase: cohort.name,
        actor: 'shared-admin',
      }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('is refused without the exact cohort name', async () => {
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort('EMPTY');

    for (const phrase of ['', 'wrong', cohort.name.toLowerCase(), 'DELETE']) {
      await expect(
        cohorts.deleteCohortPermanently(cohort.id, {
          confirmationPhrase: phrase,
          actor: 'shared-admin',
        }),
      ).rejects.toThrow(/Type the cohort name exactly/i);
    }
    expect(await cohorts.getCohort(cohort.id)).not.toBeNull();
  });

  it('writes the audit record BEFORE deleting, so it survives', async () => {
    // audit_logs.cohort_id cascades, so a record written afterwards would be
    // removed with the cohort — and a deletion nobody can see afterwards is the
    // one kind this system must not perform.
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort('EMPTY');
    await cohorts.deleteCohortPermanently(cohort.id, {
      confirmationPhrase: cohort.name,
      actor: 'shared-admin',
    });

    const { rows } = await db.query<{ action: string; after: unknown }>(
      `select action, after from audit_logs where action = 'cohort.deleted_permanently'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.after)).toContain(cohort.name);
  });

  it('reports what a cohort holds before anything is offered', async () => {
    const cohorts = buildCohortStore(db);
    const teams = buildTeamStore(db);
    const cohort = await makeCohort('COUNT');
    await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'a@example.invalid', leadPhone: '' },
      { groupNumber: 2, leadName: 'M', leadEmail: 'b@example.invalid', leadPhone: '' },
    ]);
    await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

    const deps = await cohorts.getCohortDependencies(cohort.id);
    expect(deps.teams).toBe(2);
    expect(deps.accessCodes).toBe(2);
    expect(deps.submissions).toBe(0);
    expect(deps.finalSubmissions).toBe(0);
  });
});

describe('learner email identity (migration 0005)', () => {
  async function teamIn(cohortCode: string, groupNumber: number) {
    const cohort = await makeCohort(cohortCode);
    const { created } = await buildTeamStore(db).importTeams(cohort.id, [
      { groupNumber, leadName: 'L', leadEmail: `lead${groupNumber}@x.invalid`, leadPhone: '' },
    ]);
    return { cohort, teamId: created[0]!.id };
  }

  it('refuses the same learner twice in one team', async () => {
    const { teamId } = await teamIn('C13', 1);
    await db.query(
      `insert into team_members (team_id, full_name, email) values ($1, 'A', 'p@example.invalid')`,
      [teamId],
    );
    await expect(
      db.query(
        `insert into team_members (team_id, full_name, email) values ($1, 'A again', 'p@example.invalid')`,
        [teamId],
      ),
    ).rejects.toThrow();
  });

  it('treats email as case-insensitive, so one person is not two identities', async () => {
    // The column is citext. Person@Example.com and person@example.com are the
    // same learner, which is what a spreadsheet will inevitably contain.
    const { teamId } = await teamIn('C13', 1);
    await db.query(
      `insert into team_members (team_id, full_name, email) values ($1, 'A', 'Person@Example.Invalid')`,
      [teamId],
    );
    await expect(
      db.query(
        `insert into team_members (team_id, full_name, email) values ($1, 'A', 'person@example.invalid')`,
        [teamId],
      ),
    ).rejects.toThrow();
  });

  it('ALLOWS the same learner in a later cohort', async () => {
    // The whole point of scoping the index to the team: a learner may join the
    // next AI Accelerator. A global unique(email) would lock them out forever.
    const first = await teamIn('C13', 1);
    await db.query(
      `insert into team_members (team_id, full_name, email) values ($1, 'Priya', 'p@example.invalid')`,
      [first.teamId],
    );
    await buildCohortStore(db).archiveCohort(first.cohort.id, 'shared-admin');

    const second = await teamIn('C14', 1);
    await expect(
      db.query(
        `insert into team_members (team_id, full_name, email) values ($1, 'Priya', 'p@example.invalid')`,
        [second.teamId],
      ),
    ).resolves.toBeDefined();

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from team_members where email = 'p@example.invalid'`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('allows a member row with no email, for the manual CSV path', async () => {
    const { teamId } = await teamIn('C13', 1);
    await db.query(`insert into team_members (team_id, full_name) values ($1, 'No email')`, [teamId]);
    await db.query(`insert into team_members (team_id, full_name) values ($1, 'Also none')`, [teamId]);

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from team_members where email is null',
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('teams no longer require a lead, because the real sheet has none', async () => {
    const cohort = await makeCohort('C13');
    await expect(
      db.query(
        `insert into teams (cohort_id, group_number, whatsapp_link) values ($1, 7, 'https://chat.invalid/g7')`,
        [cohort.id],
      ),
    ).resolves.toBeDefined();

    const { rows } = await db.query<{ lead_name: string | null; whatsapp_link: string }>(
      'select lead_name, whatsapp_link from teams where group_number = 7',
    );
    expect(rows[0]?.lead_name).toBeNull();
    expect(rows[0]?.whatsapp_link).toBe('https://chat.invalid/g7');
  });
});

describe('audit history outlives what it describes', () => {
  it('explains a deleted cohort without joining to anything', async () => {
    const cohorts = buildCohortStore(db);
    const cohort = await makeCohort('GONE');
    await buildAuditStore(db).record({
      actorType: 'shared-admin',
      actorRef: 'ops',
      action: 'cohort.created',
      entityType: 'cohort',
      entityId: cohort.id,
      cohortId: cohort.id,
      before: null,
      after: { name: cohort.name },
      ipHash: null,
      userAgentHash: null,
    });

    await cohorts.deleteCohortPermanently(cohort.id, {
      confirmationPhrase: cohort.name,
      actor: 'ops',
    });

    // The earlier entry survives: dropping the foreign key is what makes an
    // append-only log compatible with deletion at all.
    const { rows } = await db.query<{ action: string; entity_id: string; after: unknown; created_at: Date; actor_ref: string }>(
      `select action, entity_id, after, created_at, actor_ref from audit_logs order by created_at`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const deletion = rows.find((r) => r.action === 'cohort.deleted_permanently');
    expect(deletion).toBeDefined();

    // Everything needed to explain it, with no surviving row to join to.
    const detail = JSON.stringify(deletion?.after);
    expect(detail).toContain(cohort.name);
    expect(detail).toContain(cohort.code);
    expect(deletion?.entity_id).toBe(cohort.id);
    expect(deletion?.actor_ref).toBe('ops');
    expect(deletion?.created_at).toBeInstanceOf(Date);

    // And the cohort really is gone.
    expect(await cohorts.getCohort(cohort.id)).toBeNull();
  });
});
