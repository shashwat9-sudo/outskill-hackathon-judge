import { describe, expect, it, vi } from 'vitest';
import {
  STORAGE_BUCKETS,
  StorageError,
  assertParticipantWritable,
  createInMemoryStorage,
  createSupabaseStorage,
  pathBelongsToSubmission,
  sanitiseFilename,
  submissionObjectPath,
} from './storage';

/**
 * The storage adapter.
 *
 * Integration against real Supabase Storage needs credentials this environment
 * does not have, so the remote calls are mocked and everything decidable
 * locally is asserted directly: path construction, bucket restrictions,
 * traversal refusal, and the guarantee that no permanent public URL exists.
 */

describe('bucket inventory', () => {
  it('matches the six buckets migration 0003 creates', () => {
    expect(Object.values(STORAGE_BUCKETS).sort()).toEqual([
      'admin-resources',
      'browser-evidence',
      'internal-reports',
      'submission-decks',
      'submission-screenshots',
      'traces',
    ]);
  });

  it('offers no method that returns a permanent public URL', () => {
    // Enforced by the type, not by review: a caller cannot ask for something
    // the interface does not produce.
    const adapter = createInMemoryStorage();
    expect(Object.keys(adapter).sort()).toEqual([
      'createSignedDownloadUrl',
      'createSignedUploadUrl',
      // Added for the direct browser upload: the server has to be able to ask
      // the bucket what actually arrived before it records anything.
      'downloadHead',
      'objects',
      'remove',
      'statObject',
      'upload',
    ]);

    // Whatever the surface grows to, nothing on it may hand out a durable link.
    for (const method of Object.keys(adapter)) {
      expect(method.toLowerCase()).not.toContain('public');
    }
  });
});

describe('participant write scope', () => {
  it('allows only the deck bucket', () => {
    expect(() => assertParticipantWritable('submission-decks')).not.toThrow();
  });

  it('refuses every internal bucket', () => {
    for (const bucket of ['browser-evidence', 'traces', 'internal-reports', 'admin-resources']) {
      expect(() => assertParticipantWritable(bucket), bucket).toThrow(StorageError);
    }
  });

  it('refuses a bucket that does not exist', () => {
    expect(() => assertParticipantWritable('anything-else')).toThrow(/may not write/i);
  });
});

describe('object paths', () => {
  const cohort = '11111111-0000-4000-8000-000000000001';
  const submission = '22222222-0000-4000-8000-000000000002';

  it('scopes an object to its cohort and submission', () => {
    // The storage RLS policy in 0003 reads the second segment, so this
    // convention is load-bearing rather than cosmetic.
    expect(submissionObjectPath(cohort, submission, 'deck.pdf')).toBe(
      `${cohort}/${submission}/deck.pdf`,
    );
  });

  it('refuses to let a filename escape the team’s own prefix', () => {
    const path = submissionObjectPath(cohort, submission, '../../../etc/passwd');
    expect(path).toBe(`${cohort}/${submission}/passwd`);
    expect(path).not.toContain('..');
  });

  it('strips path separators from a Windows filename', () => {
    expect(sanitiseFilename('C:\\Users\\me\\deck.pdf')).toBe('deck.pdf');
    expect(sanitiseFilename('folder/sub/deck.pdf')).toBe('deck.pdf');
  });

  it('never produces a hidden or empty filename', () => {
    expect(sanitiseFilename('...')).toBe('file');
    expect(sanitiseFilename('')).toBe('file');
    expect(sanitiseFilename('....hidden')).toBe('hidden');
  });

  it('bounds the length so a crafted name cannot blow the key limit', () => {
    expect(sanitiseFilename(`${'a'.repeat(500)}.pdf`).length).toBeLessThanOrEqual(120);
  });

  it('replaces characters that would need escaping in a URL', () => {
    expect(sanitiseFilename('my deck (final)#2.pdf')).toBe('my-deck--final--2.pdf');
  });

  it('recognises an object belonging to a given submission', () => {
    expect(pathBelongsToSubmission(`${cohort}/${submission}/deck.pdf`, submission)).toBe(true);
  });

  it('rejects another team’s object, which is what gates a signed URL', () => {
    // A signed URL carries no authorisation of its own — anyone holding it can
    // read the object — so ownership has to be checked before one exists.
    const other = '33333333-0000-4000-8000-000000000003';
    expect(pathBelongsToSubmission(`${cohort}/${other}/deck.pdf`, submission)).toBe(false);
    expect(pathBelongsToSubmission('deck.pdf', submission)).toBe(false);
    expect(pathBelongsToSubmission('', submission)).toBe(false);
  });
});

// --------------------------------------------------------------------------

/** A Supabase client stub, so the request shape can be asserted without network. */
function mockSupabase() {
  const calls: { bucket: string; method: string; args: unknown[] }[] = [];
  const bucketApi = (bucket: string) => ({
    createSignedUrl: vi.fn(async (path: string, expiresIn: number) => {
      calls.push({ bucket, method: 'createSignedUrl', args: [path, expiresIn] });
      return { data: { signedUrl: `https://storage.invalid/${bucket}/${path}?token=x` }, error: null };
    }),
    createSignedUploadUrl: vi.fn(async (path: string) => {
      calls.push({ bucket, method: 'createSignedUploadUrl', args: [path] });
      return { data: { signedUrl: `https://storage.invalid/upload/${path}`, token: 'tok' }, error: null };
    }),
    upload: vi.fn(async (path: string, body: Uint8Array, options: unknown) => {
      calls.push({ bucket, method: 'upload', args: [path, body.byteLength, options] });
      return { error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      calls.push({ bucket, method: 'remove', args: [paths] });
      return { error: null };
    }),
  });

  vi.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ storage: { from: bucketApi } }),
  }));

  return calls;
}

describe('the Supabase adapter', () => {
  it('caps a signed URL expiry, because the URL is a bearer credential', async () => {
    const calls = mockSupabase();
    const storage = await createSupabaseStorage({ url: 'https://x.invalid', serviceRoleKey: 'k' });

    await storage.createSignedDownloadUrl('submission-decks', 'a/b/deck.pdf', 999_999);
    await storage.createSignedDownloadUrl('submission-decks', 'a/b/deck.pdf', 1);

    // Clamped to an hour at the top and half a minute at the bottom: a long
    // expiry turns a one-off view into a durable leak.
    expect(calls[0]?.args[1]).toBe(3600);
    expect(calls[1]?.args[1]).toBe(30);
    vi.doUnmock('@supabase/supabase-js');
  });

  it('refuses any bucket the application does not own', async () => {
    mockSupabase();
    const storage = await createSupabaseStorage({ url: 'https://x.invalid', serviceRoleKey: 'k' });

    await expect(storage.createSignedDownloadUrl('public-bucket', 'x')).rejects.toThrow(
      /Unknown storage bucket/,
    );
    await expect(storage.upload('public-bucket', 'x', new Uint8Array(), 'text/plain')).rejects.toThrow(
      /Unknown storage bucket/,
    );
    vi.doUnmock('@supabase/supabase-js');
  });

  it('replaces an object rather than creating a second one', async () => {
    const calls = mockSupabase();
    const storage = await createSupabaseStorage({ url: 'https://x.invalid', serviceRoleKey: 'k' });
    await storage.upload('submission-decks', 'a/b/deck.pdf', new Uint8Array([1, 2]), 'application/pdf');

    // A team that re-uploads their deck must not accumulate stale copies.
    expect(calls[0]?.args[2]).toMatchObject({ upsert: true, contentType: 'application/pdf' });
    vi.doUnmock('@supabase/supabase-js');
  });

  it('does not call remote storage for an empty removal', async () => {
    const calls = mockSupabase();
    const storage = await createSupabaseStorage({ url: 'https://x.invalid', serviceRoleKey: 'k' });
    await storage.remove('submission-decks', []);
    expect(calls).toHaveLength(0);
    vi.doUnmock('@supabase/supabase-js');
  });

  it('surfaces a storage failure rather than pretending it worked', async () => {
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        storage: {
          from: () => ({
            createSignedUrl: async () => ({ data: null, error: { message: 'Object not found' } }),
          }),
        },
      }),
    }));
    const storage = await createSupabaseStorage({ url: 'https://x.invalid', serviceRoleKey: 'k' });

    await expect(storage.createSignedDownloadUrl('traces', 'missing.zip')).rejects.toThrow(
      /Object not found/,
    );
    vi.doUnmock('@supabase/supabase-js');
  });
});

describe('the in-memory adapter', () => {
  it('mints URLs that only this process could serve', async () => {
    const storage = createInMemoryStorage();
    const url = await storage.createSignedDownloadUrl('submission-decks', 'a/b/deck.pdf');
    // A test must not be able to accidentally exercise a real bucket.
    expect(url.startsWith('/api/demo-file/')).toBe(true);
    expect(url).not.toContain('supabase');
  });

  it('round-trips and removes an object', async () => {
    const storage = createInMemoryStorage();
    await storage.upload('submission-decks', 'a/b/deck.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(storage.objects.size).toBe(1);

    await storage.remove('submission-decks', ['a/b/deck.pdf']);
    expect(storage.objects.size).toBe(0);
  });
});

// --------------------------------------------------------------------------

describe('connection string validation', () => {
  it('accepts a correctly encoded transaction-pooler URI', async () => {
    const { validateConnectionString } = await import('./client');
    expect(() =>
      validateConnectionString(
        'postgresql://postgres.ref:pass%40word%231@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      ),
    ).not.toThrow();
  });

  it('explains an unencoded "#" rather than letting it look like a network fault', async () => {
    // An unencoded '#' truncates the URI at the fragment, so `pg` reports
    // EHOSTUNREACH against a nonsense host and the operator debugs the network.
    const { validateConnectionString } = await import('./client');
    expect(() =>
      validateConnectionString(
        'postgresql://postgres.ref:pass#word@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      ),
    ).toThrow(/percent-encode the password/i);
  });

  it('tolerates an unencoded "@", because the separator is the LAST one', async () => {
    // Worth asserting rather than assuming: warning about '@' would send an
    // operator to fix something that is not broken.
    const { validateConnectionString } = await import('./client');
    expect(() =>
      validateConnectionString(
        'postgresql://postgres.ref:pa@ss@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      ),
    ).not.toThrow();
  });

  it('refuses the session pooler for a serverless deployment', async () => {
    const { validateConnectionString } = await import('./client');
    expect(() =>
      validateConnectionString(
        'postgresql://postgres.ref:pass@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
      ),
    ).toThrow(/SESSION pooler/);
  });

  it('rejects something that is not a URI at all', async () => {
    const { validateConnectionString } = await import('./client');
    expect(() => validateConnectionString('paste-your-connection-string-here')).toThrow(
      /not a valid URI/,
    );
  });
});
