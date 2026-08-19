import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildParticipantStore } from './repositories/participant';
import { buildTeamStore } from './repositories/teams';
import { createInMemoryStorage, type StorageAdapter } from './storage';
import { makeCohort } from './testing/assessment-fixtures';
import { MAX_DECK_BYTES } from '../../schemas/submission';
import type { ParticipantStore } from '../store';

/**
 * The deck upload, now that the bytes no longer pass through the server.
 *
 * A 25 MB request body cannot reach a serverless function, so the file goes
 * straight from the browser to the private bucket and the server authorises the
 * one path it may land on. That moves two risks:
 *
 *   - the path becomes the browser's only input, so it becomes the thing that
 *     has to be checked;
 *   - the server no longer holds the bytes, so it has to *ask the bucket* what
 *     arrived rather than believing what it was told.
 *
 * The second is F-7 restated. The original defect recorded an upload that never
 * happened; the direct path would repeat it exactly if confirmation trusted the
 * client, so every test here that ends in a refusal also checks that nothing
 * was recorded and that a previous deck survived.
 */

let db: PgliteHandle;
let storage: StorageAdapter & { objects: Map<string, Uint8Array> };
let participant: ParticipantStore;
let token: string;
let otherToken: string;
let cohortId: string;
let submissionId: string;

const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

/** A PDF-shaped blob of a given size. Real magic bytes, filler after. */
function pdfOfSize(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set(PDF_HEAD.slice(0, Math.min(PDF_HEAD.length, bytes)));
  return body;
}

const MB = 1024 * 1024;

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

  const cohort = await makeCohort(db, 'DIRECT');
  cohortId = cohort.id;
  await db.query("update cohorts set status = 'open' where id = $1", [cohort.id]);

  const teams = buildTeamStore(db);
  await teams.importLearnerAllocation(cohort.id, [
    { groupNumber: 1, whatsappLink: null, learners: [{ name: 'A', email: 'a@example.com' }] },
    { groupNumber: 2, whatsappLink: null, learners: [{ name: 'B', email: 'b@example.com' }] },
  ]);
  const issued = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

  storage = createInMemoryStorage();
  participant = buildParticipantStore({
    db,
    storage,
    sessionSecret: 'direct-upload-secret-long-enough-for-hmac',
    credentialKey: 'a'.repeat(64),
    credentialKeyVersion: 1,
  });

  const sessions: string[] = [];
  for (const row of issued) {
    const verified = await participant.verifyTeamAccess({
      groupNumber: row.groupNumber,
      code: row.code,
      ipHash: 'ip',
    });
    if (!verified.ok) throw new Error('setup failed');
    const session = await participant.createSession({
      teamId: verified.teamId,
      editorName: 'Tester',
      editorRole: null,
      ipHash: null,
    });
    sessions.push(session.token);
  }
  token = sessions[0]!;
  otherToken = sessions[1]!;

  const view = await participant.resolveSession(token);
  submissionId = view!.submission.id;
});

/** The whole flow, as a browser performs it. */
async function upload(bytes: Uint8Array, filename = 'deck.pdf') {
  const ticket = await participant.createDeckUploadTicket(token, {
    originalFilename: filename,
    byteSize: bytes.byteLength,
    mimeType: 'application/pdf',
  });
  if (!ticket.ok) return { ticket, confirmed: null };

  // What the browser does with the signed URL.
  storage.objects.set(`submission-decks/${ticket.storagePath}`, bytes);

  const confirmed = await participant.confirmDeckUpload(token, {
    storagePath: ticket.storagePath!,
    originalFilename: filename,
  });
  return { ticket, confirmed };
}

const deckOf = async () => {
  const view = await participant.resolveSession(token);
  return view!.artifacts.find((a) => a.kind === 'deck_pdf') ?? null;
};

// --------------------------------------------------------------------------
// Sizes
// --------------------------------------------------------------------------

describe('sizes a learner will actually send', () => {
  it.each([
    ['a small deck', 64 * 1024],
    ['just under the old server limit', 4 * MB - 1024],
    ['above the old server limit — the whole point of this change', 6 * MB],
    ['a large deck', 12 * MB],
    ['near the 25 MB limit', MAX_DECK_BYTES - 4096],
  ])('accepts %s', async (_label, size) => {
    const { confirmed } = await upload(pdfOfSize(size));
    expect(confirmed?.ok, confirmed?.error).toBe(true);

    const deck = await deckOf();
    expect(deck).not.toBeNull();
    // The size recorded is the size in the bucket, not the size claimed.
    expect(deck!.byteSize).toBe(size);
    expect(typeof deck!.byteSize).toBe('number');
    expect(storage.objects.get(`submission-decks/${deck!.storagePath}`)?.byteLength).toBe(size);
  });

  it('refuses a deck over 25 MB before it is authorised', async () => {
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'huge.pdf',
      byteSize: MAX_DECK_BYTES + 1,
      mimeType: 'application/pdf',
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/25 MB or smaller/);
    expect(ticket.uploadUrl).toBeUndefined();
  });

  it('refuses a deck over 25 MB even when the claim was a lie', async () => {
    // A client can declare 1 MB and send 30. The bucket enforces its own limit
    // in production; the confirmation enforces it here regardless.
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf',
      byteSize: MB,
      mimeType: 'application/pdf',
    });
    expect(ticket.ok).toBe(true);

    storage.objects.set(`submission-decks/${ticket.storagePath}`, pdfOfSize(MAX_DECK_BYTES + 1));
    const confirmed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/25 MB or smaller/);
    expect(await deckOf()).toBeNull();
    // And the oversize object is gone.
    expect(storage.objects.has(`submission-decks/${ticket.storagePath}`)).toBe(false);
  });

  it('refuses an empty file', async () => {
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf',
      byteSize: 1024,
      mimeType: 'application/pdf',
    });
    storage.objects.set(`submission-decks/${ticket.storagePath}`, new Uint8Array(0));
    const confirmed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });
    expect(confirmed.ok).toBe(false);
    expect(await deckOf()).toBeNull();
  });
});

// --------------------------------------------------------------------------
// What it is, not what it claims to be
// --------------------------------------------------------------------------

describe('only a PDF', () => {
  it('refuses a non-PDF extension before authorising anything', async () => {
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pptx',
      byteSize: 1024,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.uploadUrl).toBeUndefined();
  });

  it('refuses a file that is not a PDF however it was announced', async () => {
    // Named .pdf, declared application/pdf, and a ZIP inside.
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf',
      byteSize: 2048,
      mimeType: 'application/pdf',
    });
    expect(ticket.ok).toBe(true);

    const zip = new Uint8Array(2048);
    zip.set([0x50, 0x4b, 0x03, 0x04]);
    storage.objects.set(`submission-decks/${ticket.storagePath}`, zip);

    const confirmed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/not a PDF/);
    expect(await deckOf()).toBeNull();
    expect(storage.objects.has(`submission-decks/${ticket.storagePath}`)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The path is the only thing the browser controls
// --------------------------------------------------------------------------

describe('the path the server chose', () => {
  it('is under this submission, and different every time', async () => {
    const first = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 1024, mimeType: 'application/pdf',
    });
    const second = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 1024, mimeType: 'application/pdf',
    });

    expect(first.storagePath).toMatch(new RegExp(`^${cohortId}/${submissionId}/`));
    // A fresh path per attempt is what lets a failed replacement keep the old
    // deck: the new bytes never land on top of the old ones.
    expect(first.storagePath).not.toBe(second.storagePath);
  });

  it('never lets a team confirm an object outside its own submission', async () => {
    const otherView = await participant.resolveSession(otherToken);
    const otherSubmission = otherView!.submission.id;

    for (const hostile of [
      `${cohortId}/${otherSubmission}/pending-stolen.pdf`,
      `${cohortId}/../${otherSubmission}/pending-stolen.pdf`,
      'submission-decks/anything.pdf',
      `${cohortId}/${submissionId}/../${otherSubmission}/x.pdf`,
      '',
    ]) {
      storage.objects.set(`submission-decks/${hostile}`, pdfOfSize(1024));
      const confirmed = await participant.confirmDeckUpload(token, {
        storagePath: hostile,
        originalFilename: 'deck.pdf',
      });
      expect(confirmed.ok, `accepted a hostile path: ${hostile}`).toBe(false);
    }

    expect(await deckOf()).toBeNull();
  });

  it('gives one team no way to read another team’s deck', async () => {
    const { confirmed } = await upload(pdfOfSize(4096));
    expect(confirmed?.ok).toBe(true);
    const deck = await deckOf();

    // The other team's session sees its own artifacts, and there are none.
    const otherView = await participant.resolveSession(otherToken);
    expect(otherView!.artifacts.some((a) => a.kind === 'deck_pdf')).toBe(false);

    // And it cannot adopt the object by confirming its path.
    const stolen = await participant.confirmDeckUpload(otherToken, {
      storagePath: deck!.storagePath!,
      originalFilename: 'deck.pdf',
    });
    expect(stolen.ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Failure must never cost a team the deck it already had
// --------------------------------------------------------------------------

describe('replacing a deck', () => {
  it('keeps the old one when the new upload never arrives', async () => {
    const { confirmed } = await upload(pdfOfSize(8192), 'original.pdf');
    expect(confirmed?.ok).toBe(true);
    const before = await deckOf();

    // A ticket is issued and the browser dies before sending anything.
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'replacement.pdf', byteSize: 4096, mimeType: 'application/pdf',
    });
    const failed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'replacement.pdf',
    });

    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/did not finish/i);

    const after = await deckOf();
    expect(after!.storagePath).toBe(before!.storagePath);
    expect(after!.originalFilename).toBe('original.pdf');
    expect(storage.objects.has(`submission-decks/${before!.storagePath}`)).toBe(true);
  });

  it('keeps the old one when the replacement is rejected', async () => {
    const { confirmed } = await upload(pdfOfSize(8192), 'original.pdf');
    expect(confirmed?.ok).toBe(true);
    const before = await deckOf();

    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'replacement.pdf', byteSize: 4096, mimeType: 'application/pdf',
    });
    storage.objects.set(`submission-decks/${ticket.storagePath}`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const rejected = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'replacement.pdf',
    });

    expect(rejected.ok).toBe(false);
    const after = await deckOf();
    expect(after!.storagePath).toBe(before!.storagePath);
    expect(after!.originalFilename).toBe('original.pdf');
    expect(storage.objects.get(`submission-decks/${before!.storagePath}`)?.byteLength).toBe(8192);
  });

  it('removes the previous object once the new one is safely recorded', async () => {
    const first = await upload(pdfOfSize(8192), 'first.pdf');
    const firstPath = first.ticket.storagePath!;
    expect(storage.objects.has(`submission-decks/${firstPath}`)).toBe(true);

    const second = await upload(pdfOfSize(16384), 'second.pdf');
    expect(second.confirmed?.ok).toBe(true);

    const deck = await deckOf();
    expect(deck!.originalFilename).toBe('second.pdf');
    expect(deck!.byteSize).toBe(16384);
    // Exactly one deck row, and the superseded object cleaned up.
    const view = await participant.resolveSession(token);
    expect(view!.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(1);
    expect(storage.objects.has(`submission-decks/${firstPath}`)).toBe(false);
  });

  it('leaves no orphan behind when a confirmation is refused', async () => {
    const before = storage.objects.size;

    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 4096, mimeType: 'application/pdf',
    });
    storage.objects.set(`submission-decks/${ticket.storagePath}`, new Uint8Array(4096)); // not a PDF
    await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });

    expect(storage.objects.size).toBe(before);
  });
});

// --------------------------------------------------------------------------
// F-7, restated for the new path
// --------------------------------------------------------------------------

describe('a recorded deck means stored bytes', () => {
  it('records nothing when Storage holds nothing, however confident the client is', async () => {
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 5 * MB, mimeType: 'application/pdf',
    });
    // No upload happens at all — the exact shape of F-7.
    const confirmed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });

    expect(confirmed.ok).toBe(false);
    const { rows } = await db.query(
      `select count(*)::int as n from submission_artifacts where kind = 'deck_pdf'`,
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('every recorded deck resolves to an object of the recorded size', async () => {
    await upload(pdfOfSize(3 * MB));
    const { rows } = await db.query<{ storage_bucket: string; storage_path: string; byte_size: string }>(
      `select storage_bucket, storage_path, byte_size from submission_artifacts where kind = 'deck_pdf'`,
    );
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      const stored = storage.objects.get(`${row.storage_bucket}/${row.storage_path}`);
      expect(stored, 'a row with no object behind it').toBeDefined();
      expect(stored!.byteLength).toBe(Number(row.byte_size));
    }
  });
});

// --------------------------------------------------------------------------
// Window and session rules are unchanged
// --------------------------------------------------------------------------

describe('who may upload at all', () => {
  it('refuses an unknown session', async () => {
    const ticket = await participant.createDeckUploadTicket('not-a-token', {
      originalFilename: 'deck.pdf', byteSize: 1024, mimeType: 'application/pdf',
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.uploadUrl).toBeUndefined();
  });

  it('refuses once the cohort is closed', async () => {
    await db.query("update cohorts set status = 'closed' where id = $1", [cohortId]);
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 1024, mimeType: 'application/pdf',
    });
    expect(ticket.ok).toBe(false);
  });

  it('refuses a confirmation once the cohort is closed, even with a live ticket', async () => {
    const ticket = await participant.createDeckUploadTicket(token, {
      originalFilename: 'deck.pdf', byteSize: 4096, mimeType: 'application/pdf',
    });
    storage.objects.set(`submission-decks/${ticket.storagePath}`, pdfOfSize(4096));

    await db.query("update cohorts set status = 'closed' where id = $1", [cohortId]);

    const confirmed = await participant.confirmDeckUpload(token, {
      storagePath: ticket.storagePath!,
      originalFilename: 'deck.pdf',
    });
    expect(confirmed.ok).toBe(false);
    expect(await deckOf()).toBeNull();
  });
});
