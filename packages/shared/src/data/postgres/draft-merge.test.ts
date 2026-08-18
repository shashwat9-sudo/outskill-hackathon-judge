import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildParticipantStore } from './repositories/participant';
import { buildTeamStore } from './repositories/teams';
import { createInMemoryStorage } from './storage';
import { makeCohort } from './testing/assessment-fixtures';
import type { ParticipantStore } from '../store';

/**
 * Saving one step must not destroy the others.
 *
 * `saveDraft` used to write the incoming payload wholesale, so a caller that
 * sent `{ live: {...} }` replaced the entire draft — team details, product
 * answers, declarations and the demo-duration confirmation all vanished.
 *
 * The submission form always posts all six steps, which hid this completely.
 * It surfaced during the acceptance run, when a store-level save of a single
 * step wiped five steps from a real submission. Everything that lives in a
 * promoted column survived; everything that lives only in the payload did not.
 *
 * Any of these would have triggered it in production: a client that saves the
 * current step, an autosave optimised to send only what changed, a retry that
 * posts a subset, or a second client written against the same store.
 */

let db: PgliteHandle;
let participant: ParticipantStore;
let token: string;

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

  const cohort = await makeCohort(db, 'MERGE');
  await db.query("update cohorts set status = 'open' where id = $1", [cohort.id]);

  const teams = buildTeamStore(db);
  await teams.importLearnerAllocation(cohort.id, [
    { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@acceptance.test' }] },
  ]);
  const [issued] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

  participant = buildParticipantStore({
    db,
    storage: createInMemoryStorage(),
    sessionSecret: 'acceptance-secret-long-enough-for-hmac-use',
    credentialKey: 'a'.repeat(64),
    credentialKeyVersion: 1,
  });

  const verified = await participant.verifyTeamAccess({
    groupNumber: 1,
    code: issued!.code,
    ipHash: 'ip',
  });
  if (!verified.ok) throw new Error('setup failed');
  const session = await participant.createSession({
    teamId: verified.teamId,
    editorName: 'A',
    editorRole: null,
    ipHash: null,
  });
  token = session.token;
});

async function currentPayload(): Promise<Record<string, unknown>> {
  const view = await participant.resolveSession(token);
  return (view!.submission.draftPayload ?? {}) as Record<string, unknown>;
}

async function version(): Promise<number> {
  return (await participant.resolveSession(token))!.submission.version;
}

/** A draft with every step populated, as the form posts it. */
const FULL_DRAFT = {
  team: { groupNumber: 1, leadName: 'A Lead', members: ['A'] },
  product: { productName: 'Test Product', primaryUser: 'Someone' },
  live: { productUrl: 'https://example.invalid', knownLimitations: 'Some limits' },
  artifacts: { demoUnderThreeMinutes: true },
  learning: { mostImportantLearning: 'A lesson' },
  declarations: { ownWork: true, noProhibitedContent: true },
};

// --------------------------------------------------------------------------

describe('saving a single step', () => {
  it('leaves every other step exactly as it was', async () => {
    await participant.saveDraft(token, FULL_DRAFT, await version());

    await participant.saveDraft(
      token,
      { live: { productUrl: 'https://changed.invalid', knownLimitations: 'Changed' } },
      await version(),
    );

    const payload = await currentPayload();
    expect(Object.keys(payload).sort()).toEqual(
      ['artifacts', 'declarations', 'learning', 'live', 'product', 'team'].sort(),
    );
    expect(payload.team).toEqual(FULL_DRAFT.team);
    expect(payload.product).toEqual(FULL_DRAFT.product);
    expect(payload.declarations).toEqual(FULL_DRAFT.declarations);
    expect(payload.learning).toEqual(FULL_DRAFT.learning);
  });

  it('does update the step it was given', async () => {
    await participant.saveDraft(token, FULL_DRAFT, await version());
    await participant.saveDraft(
      token,
      { live: { productUrl: 'https://changed.invalid', knownLimitations: 'Changed' } },
      await version(),
    );

    const payload = await currentPayload();
    expect(payload.live).toEqual({
      productUrl: 'https://changed.invalid',
      knownLimitations: 'Changed',
    });
  });

  it('preserves the demo-duration confirmation, which lives nowhere else', async () => {
    // No column holds this. A replacing save loses it permanently, and the
    // learner's Demo-and-deck step silently reverts to incomplete.
    await participant.saveDraft(token, FULL_DRAFT, await version());
    await participant.saveDraft(token, { product: { productName: 'Renamed' } }, await version());

    const payload = await currentPayload();
    expect((payload.artifacts as { demoUnderThreeMinutes?: boolean }).demoUnderThreeMinutes).toBe(
      true,
    );
  });

  it('preserves the declarations, which also live nowhere else', async () => {
    await participant.saveDraft(token, FULL_DRAFT, await version());
    await participant.saveDraft(token, { live: { productUrl: 'https://x.invalid' } }, await version());

    expect(await currentPayload().then((p) => p.declarations)).toEqual(FULL_DRAFT.declarations);
  });
});

describe('replacing a step', () => {
  it('replaces it wholly, so a field can still be cleared', async () => {
    // Merged per step, not deeply. A deep merge would make it impossible to
    // remove an answer a team decided was wrong.
    await participant.saveDraft(token, FULL_DRAFT, await version());
    await participant.saveDraft(token, { product: { productName: 'Only this' } }, await version());

    expect(await currentPayload().then((p) => p.product)).toEqual({ productName: 'Only this' });
  });
});

describe('a series of partial saves', () => {
  it('accumulates into one complete draft', async () => {
    // A team filling in one step at a time, which is how the form is used.
    for (const [step, value] of Object.entries(FULL_DRAFT)) {
      const result = await participant.saveDraft(token, { [step]: value }, await version());
      expect(result.ok, `saving ${step}`).toBe(true);
    }

    expect(await currentPayload()).toEqual(FULL_DRAFT);
  });

  it('still promotes answers into their columns', async () => {
    await participant.saveDraft(token, { product: FULL_DRAFT.product }, await version());
    await participant.saveDraft(token, { live: FULL_DRAFT.live }, await version());

    const view = await participant.resolveSession(token);
    expect(view!.submission.productName).toBe('Test Product');
    expect(view!.submission.productUrl).toBe('https://example.invalid');
  });
});

describe('an empty save', () => {
  it('changes nothing', async () => {
    await participant.saveDraft(token, FULL_DRAFT, await version());
    const result = await participant.saveDraft(token, {}, await version());

    expect(result.ok).toBe(true);
    expect(await currentPayload()).toEqual(FULL_DRAFT);
  });
});

describe('a stale partial save', () => {
  it('is refused, and destroys nothing', async () => {
    // The dangerous combination: a conflict AND a partial payload. A refused
    // write must leave the stored draft entirely untouched.
    await participant.saveDraft(token, FULL_DRAFT, await version());
    const staleVersion = await version();

    await participant.saveDraft(token, { product: { productName: 'Winner' } }, staleVersion);

    const loser = await participant.saveDraft(token, { live: {} }, staleVersion);
    expect(loser.ok).toBe(false);
    expect(loser.conflict).toBeTruthy();

    const payload = await currentPayload();
    expect(payload.team).toEqual(FULL_DRAFT.team);
    expect(payload.declarations).toEqual(FULL_DRAFT.declarations);
    expect(payload.live).toEqual(FULL_DRAFT.live);
  });
});
