import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildParticipantStore } from './repositories/participant';
import { buildTeamStore } from './repositories/teams';
import { createInMemoryStorage, type StorageAdapter } from './storage';
import { makeCohort } from './testing/assessment-fixtures';
import type { ParticipantStore } from '../store';

/**
 * A recorded upload must mean a stored file.
 *
 * Found during the Phase A acceptance run. A team uploaded a 706 KB PDF, the
 * interface confirmed it, and the database held an artifact row naming the
 * bucket, the path, the size and the MIME type. Supabase Storage held nothing —
 * the bucket was completely empty.
 *
 * The upload path validated the file thoroughly (extension, MIME, size, magic
 * bytes) and then wrote only the metadata. A comment claimed the bytes were
 * skipped "in demo mode"; there was no demo branch, so they were never written
 * at all.
 *
 * Every team would have submitted successfully and no deck would have existed.
 * Nobody would have found out until judges opened the bucket after the
 * deadline, by which time the deadline has passed and the work is gone.
 */

let db: PgliteHandle;
let storage: StorageAdapter;
let participant: ParticipantStore;
let token: string;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]);

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test rubric', true)`,
  );

  const cohort = await makeCohort(db, 'DECK');
  await db.query("update cohorts set status = 'open' where id = $1", [cohort.id]);

  const teams = buildTeamStore(db);
  await teams.importLearnerAllocation(cohort.id, [
    { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@acceptance.test' }] },
  ]);
  const [issued] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

  storage = createInMemoryStorage();
  participant = buildParticipantStore({
    db,
    storage,
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

// --------------------------------------------------------------------------

describe('uploading a deck', () => {
  it('puts the bytes in the bucket, not just a row in the table', async () => {
    // The assertion the original code would have failed.
    const artifact = await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });

    expect(artifact).not.toBeNull();
    const url = await storage.createSignedDownloadUrl(
      artifact!.storageBucket!,
      artifact!.storagePath!,
    );
    expect(url).toBeTruthy();
  });

  it('records the size of what was actually stored', async () => {
    // Not the size the client claimed. The old path trusted `file.size`.
    const artifact = await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });
    expect(artifact!.byteSize).toBe(PDF_BYTES.byteLength);
  });

  it('makes the deck visible to the submission view', async () => {
    await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });

    const view = await participant.resolveSession(token);
    const deck = view?.artifacts.find((a) => a.kind === 'deck_pdf');
    expect(deck).toBeDefined();
    expect(deck?.originalFilename).toBe('pitch.pdf');
  });

  it('survives a reload of the session', async () => {
    await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });

    const reloaded = await participant.resolveSession(token);
    expect(reloaded?.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(1);
  });

  it('replaces rather than accumulates', async () => {
    for (const name of ['first.pdf', 'second.pdf']) {
      await participant.uploadDeck(token, {
        bytes: PDF_BYTES,
        originalFilename: name,
        mimeType: 'application/pdf',
      });
    }

    const view = await participant.resolveSession(token);
    const decks = view!.artifacts.filter((a) => a.kind === 'deck_pdf');
    expect(decks).toHaveLength(1);
    expect(decks[0]?.originalFilename).toBe('second.pdf');
  });
});

describe('when storage fails', () => {
  it('records nothing, so the interface cannot report a false success', async () => {
    // The property that makes the fix meaningful: a failed upload must leave no
    // trace suggesting a deck exists.
    const failing: StorageAdapter = {
      ...storage,
      upload: async () => {
        throw new Error('bucket unavailable');
      },
    };
    const store = buildParticipantStore({
      db,
      storage: failing,
      sessionSecret: 'acceptance-secret-long-enough-for-hmac-use',
      credentialKey: 'a'.repeat(64),
      credentialKeyVersion: 1,
    });

    await expect(
      store.uploadDeck(token, {
        bytes: PDF_BYTES,
        originalFilename: 'pitch.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/bucket unavailable/);

    const view = await participant.resolveSession(token);
    expect(view?.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(0);
  });

  it('leaves an earlier successful upload intact', async () => {
    // A failed replacement must not destroy the deck a team already has.
    await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'good.pdf',
      mimeType: 'application/pdf',
    });

    const failing: StorageAdapter = {
      ...storage,
      upload: async () => {
        throw new Error('bucket unavailable');
      },
    };
    const store = buildParticipantStore({
      db,
      storage: failing,
      sessionSecret: 'acceptance-secret-long-enough-for-hmac-use',
      credentialKey: 'a'.repeat(64),
      credentialKeyVersion: 1,
    });

    await expect(
      store.uploadDeck(token, {
        bytes: PDF_BYTES,
        originalFilename: 'bad.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow();

    const view = await participant.resolveSession(token);
    const decks = view!.artifacts.filter((a) => a.kind === 'deck_pdf');
    expect(decks).toHaveLength(1);
    expect(decks[0]?.originalFilename).toBe('good.pdf');
  });
});

describe('an invalid session', () => {
  it('uploads nothing', async () => {
    expect(
      await participant.uploadDeck('not-a-real-token', {
        bytes: PDF_BYTES,
        originalFilename: 'pitch.pdf',
        mimeType: 'application/pdf',
      }),
    ).toBeNull();
  });
});

describe('the recorded byte size', () => {
  it('is a number, not the string Postgres returns for a bigint', async () => {
    // `byte_size` is a bigint, and `pg` returns those as strings to avoid silent
    // precision loss. Without an explicit conversion the value is a string
    // wearing a number's type — and `"9" > "10"` is true, so every size
    // comparison is wrong for certain pairs. Found when a real 64,476-byte deck
    // came back as "64476" during the acceptance run.
    const artifact = await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });

    expect(typeof artifact!.byteSize).toBe('number');
    expect(artifact!.byteSize).toBe(PDF_BYTES.byteLength);
  });

  it('is a number when read back through the session view', async () => {
    await participant.uploadDeck(token, {
      bytes: PDF_BYTES,
      originalFilename: 'pitch.pdf',
      mimeType: 'application/pdf',
    });

    const view = await participant.resolveSession(token);
    const deck = view!.artifacts.find((a) => a.kind === 'deck_pdf');
    expect(typeof deck!.byteSize).toBe('number');
  });

  it('compares correctly against a size limit', () => {
    // The failure this prevents, stated directly.
    expect(9 > 10).toBe(false);
    expect(('9' as unknown as number) > ('10' as unknown as number)).toBe(true);
  });
});
