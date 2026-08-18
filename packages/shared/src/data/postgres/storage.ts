/**
 * File storage.
 *
 * Every bucket is private (migration `0003`). There is deliberately no method
 * here that returns a permanent public URL, because the type system is a better
 * place to enforce that than a code review: a caller cannot ask for something
 * this interface will not produce.
 *
 * Reads happen through short-lived signed URLs minted server-side after an
 * authorisation check. Writes happen either through a signed upload URL handed
 * to a browser, or directly from the server for bytes the server already holds.
 */

/** Buckets this application knows about. Anything else is a bug, not a feature. */
export const STORAGE_BUCKETS = {
  /** Participant pitch decks. The only bucket a participant writes to. */
  submissionDecks: 'submission-decks',
  /** Screenshots captured while testing a participant product. */
  submissionScreenshots: 'submission-screenshots',
  /** Per-step browser evidence. */
  browserEvidence: 'browser-evidence',
  /** Playwright traces — a trace can contain a product in an authenticated state. */
  traces: 'traces',
  /** Generated internal reports. */
  internalReports: 'internal-reports',
  /** Templates, instructions, the playbook. */
  adminResources: 'admin-resources',
} as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

const ALL_BUCKETS: readonly string[] = Object.values(STORAGE_BUCKETS);

/** Buckets a participant may ever write to. Deliberately one. */
const PARTICIPANT_WRITABLE: readonly string[] = [STORAGE_BUCKETS.submissionDecks];

export class StorageError extends Error {
  override readonly name = 'StorageError';
}

export interface StorageAdapter {
  /** A time-limited read URL. The only way to read a stored object. */
  createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string>;
  /** A time-limited write URL, for a browser upload that does not pass through the server. */
  createSignedUploadUrl(bucket: string, path: string): Promise<{ url: string; token: string }>;
  /** Upload bytes the server already holds. */
  upload(bucket: string, path: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;

  /**
   * What is actually in the bucket at this path, according to the bucket.
   *
   * Null when there is nothing there. This is the question F-7 was never asked:
   * an artifact row said a deck existed, and nothing had checked. A client's
   * claim about what it uploaded is a claim; this is the answer.
   */
  statObject(bucket: string, path: string): Promise<{ byteSize: number; mimeType: string | null } | null>;

  /**
   * The first `bytes` of an object.
   *
   * Enough to read a file signature without pulling 25 MB through a serverless
   * function to look at four characters.
   */
  downloadHead(bucket: string, path: string, bytes: number): Promise<Uint8Array | null>;
}

// --------------------------------------------------------------------------
// Path convention
// --------------------------------------------------------------------------

/**
 * Object paths are `<cohortId>/<submissionId>/<filename>`.
 *
 * The storage RLS policy in `0003` reads the second segment and checks it
 * against the caller's own submissions, so the convention is load-bearing
 * rather than cosmetic — a path built any other way is not merely untidy, it
 * fails the policy.
 */
export function submissionObjectPath(
  cohortId: string,
  submissionId: string,
  filename: string,
): string {
  return `${cohortId}/${submissionId}/${sanitiseFilename(filename)}`;
}

/**
 * Strip anything that could escape the intended prefix.
 *
 * A filename arrives from a participant's filesystem. `../` in it would place
 * the object outside the team's own prefix, which is exactly the isolation the
 * path convention exists to provide.
 */
export function sanitiseFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

/**
 * Does this object path belong to this submission?
 *
 * Used before minting a signed URL. The signed URL itself carries no
 * authorisation — anyone holding it can read the object until it expires — so
 * the check has to happen before one exists.
 */
export function pathBelongsToSubmission(path: string, submissionId: string): boolean {
  const segments = path.split('/');
  return segments.length >= 2 && segments[1] === submissionId;
}

/** Refuse a write to a bucket participants must never reach. */
export function assertParticipantWritable(bucket: string): void {
  if (!PARTICIPANT_WRITABLE.includes(bucket)) {
    throw new StorageError(
      `Participants may not write to "${bucket}". Only ${PARTICIPANT_WRITABLE.join(', ')} is writable.`,
    );
  }
}

function assertKnownBucket(bucket: string): void {
  if (!ALL_BUCKETS.includes(bucket)) {
    throw new StorageError(`Unknown storage bucket "${bucket}".`);
  }
}

// --------------------------------------------------------------------------
// Supabase Storage
// --------------------------------------------------------------------------

export interface SupabaseStorageOptions {
  url: string;
  /** Service role. Server-side only — it bypasses RLS and must never reach a browser. */
  serviceRoleKey: string;
}

/** The slice of the Supabase storage client used here. */
interface StorageObjectRow {
  name: string;
  metadata?: { size?: number; mimetype?: string } | null;
}

interface StorageBucketApi {
  createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  createSignedUploadUrl(path: string): Promise<{ data: { signedUrl: string; token: string } | null; error: { message: string } | null }>;
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
  list(
    prefix: string,
    options: { search?: string; limit?: number },
  ): Promise<{ data: StorageObjectRow[] | null; error: { message: string } | null }>;
}

export async function createSupabaseStorage(
  options: SupabaseStorageOptions,
): Promise<StorageAdapter> {
  const { createClient } = (await import('@supabase/supabase-js')) as unknown as {
    createClient: (
      url: string,
      key: string,
      config: Record<string, unknown>,
    ) => { storage: { from(bucket: string): StorageBucketApi } };
  };

  const client = createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const bucket = (name: string): StorageBucketApi => {
    assertKnownBucket(name);
    return client.storage.from(name);
  };

  // Hoisted so `downloadHead` can call it without reaching for `this`, which
  // inside an object literal is not the adapter.
  const signDownload = async (name: string, path: string, expiresInSeconds = 300): Promise<string> => {
    // Capped at an hour. A signed URL is a bearer credential: anyone it is
    // forwarded to can read the object, so a long expiry turns a one-off view
    // into a durable leak.
    const expiry = Math.min(Math.max(expiresInSeconds, 30), 3600);
    const { data, error } = await bucket(name).createSignedUrl(path, expiry);
    if (error || !data) {
      throw new StorageError(`Could not sign ${name}/${path}: ${error?.message ?? 'no URL returned'}`);
    }
    return data.signedUrl;
  };

  return {
    createSignedDownloadUrl: signDownload,

    async createSignedUploadUrl(name, path) {
      const { data, error } = await bucket(name).createSignedUploadUrl(path);
      if (error || !data) {
        throw new StorageError(
          `Could not create an upload URL for ${name}/${path}: ${error?.message ?? 'no URL returned'}`,
        );
      }
      return { url: data.signedUrl, token: data.token };
    },

    async upload(name, path, body, contentType) {
      const { error } = await bucket(name).upload(path, body, { contentType, upsert: true });
      if (error) throw new StorageError(`Could not upload ${name}/${path}: ${error.message}`);
    },

    async remove(name, paths) {
      if (paths.length === 0) return;
      const { error } = await bucket(name).remove(paths);
      if (error) throw new StorageError(`Could not remove from ${name}: ${error.message}`);
    },

    async statObject(name, path) {
      // `list` on the containing folder, filtered to the one name. Supabase has
      // no head-object call; listing the parent and matching exactly is the
      // documented way to ask whether a specific object is there.
      const lastSlash = path.lastIndexOf('/');
      const folder = lastSlash === -1 ? '' : path.slice(0, lastSlash);
      const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);

      const { data, error } = await bucket(name).list(folder, { search: filename, limit: 100 });
      if (error) throw new StorageError(`Could not stat ${name}/${path}: ${error.message}`);

      // `search` is a prefix match, so the exact name still has to be picked out
      // — "pitch-deck.pdf" would otherwise match "pitch-deck.pdf.bak".
      const row = (data ?? []).find((entry) => entry.name === filename);
      if (!row) return null;

      return {
        byteSize: Number(row.metadata?.size ?? 0),
        mimeType: row.metadata?.mimetype ?? null,
      };
    },

    async downloadHead(name, path, bytes) {
      const url = await signDownload(name, path, 60);
      const response = await fetch(url, { headers: { Range: `bytes=0-${Math.max(0, bytes - 1)}` } });
      // 206 for a served range, 200 if the object is smaller than the range.
      if (!response.ok && response.status !== 206) return null;
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

/**
 * A storage adapter that holds objects in memory.
 *
 * Used by tests and by the demo path. It mints URLs that only this process can
 * serve, so nothing it produces is reachable from outside — which is the point:
 * a test must not be able to accidentally exercise a real bucket.
 */
export function createInMemoryStorage(): StorageAdapter & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const key = (bucket: string, path: string) => `${bucket}/${path}`;

  return {
    objects,
    async createSignedDownloadUrl(bucket, path, expiresInSeconds = 300) {
      assertKnownBucket(bucket);
      return `/api/demo-file/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}?expires=${expiresInSeconds}`;
    },
    async createSignedUploadUrl(bucket, path) {
      assertKnownBucket(bucket);
      return { url: `/api/demo-upload/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}`, token: 'demo' };
    },
    async upload(bucket, path, body) {
      assertKnownBucket(bucket);
      objects.set(key(bucket, path), body);
    },
    async remove(bucket, paths) {
      for (const path of paths) objects.delete(key(bucket, path));
    },
    async statObject(bucket, path) {
      assertKnownBucket(bucket);
      const body = objects.get(key(bucket, path));
      if (!body) return null;
      return { byteSize: body.byteLength, mimeType: 'application/pdf' };
    },
    async downloadHead(bucket, path, bytes) {
      assertKnownBucket(bucket);
      const body = objects.get(key(bucket, path));
      if (!body) return null;
      return body.slice(0, bytes);
    },
  };
}
