import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvidenceUploader } from './evidence-upload';

/**
 * The worker's half of durable evidence.
 *
 * Two properties matter here and the rest is plumbing. The worker must never
 * hold or leak a Storage credential — the signed URL is the whole authorisation
 * and our own token must not travel to a host we do not control. And a local
 * capture must not be deleted until the web app has confirmed the object is
 * really in the bucket, because a deleted file that never uploaded is evidence
 * destroyed by tidiness.
 */

const TOKEN = 'x'.repeat(48);
const JOB = '33333333-3333-4333-8333-333333333333';
const UPLOAD_URL = 'https://storage.example.test/signed/one-path?token=abc';

let dir: string;
let localPath: string;

/** What each request looked like, so the assertions can be about facts. */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function buildFetch(script: Array<{ status: number; json?: unknown; throws?: boolean }>) {
  const seen: Seen[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
    });
    const step = script[i] ?? script[script.length - 1]!;
    i += 1;
    if (step.throws) throw new Error('network down');
    return {
      status: step.status,
      json: async () => step.json ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** The two web-app responses of a successful round trip. */
const ticketOk = {
  status: 200,
  json: {
    ok: true,
    uploadUrl: UPLOAD_URL,
    bucket: 'traces',
    storagePath: `c/s/${JOB}/trace/desktop.zip`,
    maxBytes: 50 * 1024 * 1024,
    expiresInSeconds: 300,
    attempt: 2,
  },
};
const putOk = { status: 200 };
const confirmOk = {
  status: 200,
  json: { ok: true, bucket: 'traces', storagePath: `c/s/${JOB}/trace/desktop.zip`, byteSize: 9 },
};

function uploader(
  script: Array<{ status: number; json?: unknown; throws?: boolean }>,
  overrides: Partial<Parameters<typeof createEvidenceUploader>[0]> = {},
) {
  const { impl, seen } = buildFetch(script);
  const instance = createEvidenceUploader({
    baseUrl: 'https://judge.example.test/',
    token: TOKEN,
    workerId: 'worker-1',
    retryDelayMs: 0,
    fetchImpl: impl,
    sleepImpl: async () => {},
    ...overrides,
  });
  return { instance, seen };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ohj-evidence-'));
  localPath = join(dir, 'desktop.zip');
  await writeFile(localPath, 'trace-bytes');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = async (p: string) => readFile(p).then(() => true).catch(() => false);

describe('a confirmed upload', () => {
  it('asks, uploads, confirms, and only then deletes the local copy', async () => {
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
    expect(result.storagePath).toBe(`c/s/${JOB}/trace/desktop.zip`);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(seen[0]!.url).toContain('/api/internal/worker/evidence/upload-ticket');
    expect(seen[1]!.url).toBe(UPLOAD_URL);
    expect(seen[2]!.url).toContain('/api/internal/worker/evidence/confirm');
    expect(await exists(localPath)).toBe(false);
  });

  it('echoes the attempt the ticket was issued under', async () => {
    // This is what ties the upload to one attempt of the job. Without it a
    // superseded worker's evidence would overwrite the run that replaced it.
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(JSON.parse(String(seen[2]!.body)).attempt).toBe(2);
  });

  it('sends the bytes that are on disk, not a path', async () => {
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(Buffer.from(seen[1]!.body as Uint8Array).toString()).toBe('trace-bytes');
  });
});

describe('the credential boundary', () => {
  it('never sends our token to the storage host', async () => {
    /*
     * The single most important assertion in this file.
     *
     * The PUT goes to a host we do not control, authorised by what is inside
     * the signed URL. Attaching the worker's token to it would hand a
     * general-purpose credential to a third party — and it is an easy mistake
     * to make, because a shared `post` helper would do it silently.
     */
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    const put = seen.find((s) => s.method === 'PUT')!;
    expect(Object.keys(put.headers)).not.toContain('authorization');
    expect(JSON.stringify(put)).not.toContain(TOKEN);
  });

  it('sends the token to the web app as a bearer header, never in a URL', async () => {
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    for (const call of seen.filter((s) => s.method === 'POST')) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
    }
  });
});

describe('an upload that fails', () => {
  it('keeps the local file when the confirmation is refused', async () => {
    // The file is the only remaining copy. Deleting it here would destroy
    // evidence that a retry could still have saved.
    const { instance } = uploader([
      ticketOk,
      putOk,
      { status: 409, json: { ok: false, error: 'The upload did not finish.' } },
    ]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(false);
    expect(result.retained).toBe(true);
    expect(await exists(localPath)).toBe(true);
  });

  it('keeps the local file when the ticket is refused', async () => {
    const { instance } = uploader([
      { status: 409, json: { ok: false, error: 'This worker does not hold a live lease on that job.' } },
    ]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/live lease/i);
    expect(await exists(localPath)).toBe(true);
  });

  it('does not retry a refusal that will never succeed', async () => {
    /*
     * A superseded attempt is the case that matters. Retrying it would mean a
     * worker whose job has been taken away hammering the confirmation endpoint
     * for evidence that must not be recorded.
     */
    const { instance, seen } = uploader([
      { status: 409, json: { ok: false, error: 'the job is now on attempt 3' } },
    ]);
    await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(seen).toHaveLength(1);
  });

  it('retries a server error and succeeds on a later attempt', async () => {
    const { instance, seen } = uploader([
      { status: 503, json: {} },
      ticketOk,
      putOk,
      confirmOk,
    ]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(4);
    expect(await exists(localPath)).toBe(false);
  });

  it('retries a transport failure rather than treating it as a refusal', async () => {
    const { instance } = uploader([ticketOk, { status: 0, throws: true }, ticketOk, putOk, confirmOk]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
  });

  it('gives up after a bounded number of attempts, keeping the bytes', async () => {
    // Unbounded retries against a web app that is down would stall the queue.
    const { instance, seen } = uploader([{ status: 500, json: {} }], { maxAttempts: 3 });
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(false);
    expect(result.retained).toBe(true);
    expect(seen).toHaveLength(3);
    expect(await exists(localPath)).toBe(true);
  });

  it('re-tickets when the signed URL has expired mid-run', async () => {
    // A slow trace can outlive its authorisation. The right response is a fresh
    // ticket, not a lost capture.
    const { instance, seen } = uploader([ticketOk, { status: 400 }, ticketOk, putOk, confirmOk]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
    expect(seen.filter((s) => s.url.includes('upload-ticket'))).toHaveLength(2);
  });
});

describe('what is never attempted', () => {
  it('refuses a file that is not there, without calling the web app', async () => {
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    const result = await instance.upload({
      jobId: JOB,
      kind: 'trace',
      localPath: join(dir, 'never-written.zip'),
      runId: 'run-1',
    });

    expect(result.ok).toBe(false);
    expect(result.retained).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('refuses an empty capture rather than recording a zero-byte object', async () => {
    const empty = join(dir, 'empty.zip');
    await writeFile(empty, '');
    const { instance, seen } = uploader([ticketOk, putOk, confirmOk]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath: empty, runId: 'run-1' });

    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('does not send an object larger than the ticket allows', async () => {
    const { instance, seen } = uploader([{ ...ticketOk, json: { ...ticketOk.json, maxBytes: 4 } }]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(false);
    expect(seen.some((s) => s.method === 'PUT')).toBe(false);
    expect(await exists(localPath)).toBe(true);
  });
});

describe('running the same upload twice', () => {
  it('is safe, because the path is derived from the job and not from a counter', async () => {
    /*
     * Interruption and restart, in miniature. A worker that dies after the PUT
     * and before the confirmation retries the whole sequence; the server issues
     * the same path, the object is overwritten with identical bytes, and the
     * confirmation says so rather than creating a second record.
     */
    await writeFile(localPath, 'trace-bytes');
    const { instance, seen } = uploader([
      ticketOk,
      putOk,
      { status: 200, json: { ...confirmOk.json, alreadyRecorded: true } },
    ]);
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
    expect(result.storagePath).toBe(`c/s/${JOB}/trace/desktop.zip`);
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(1);
  });

  it('still reports success when the local file cannot be removed', async () => {
    // The evidence is durable; a stale file in a disposable container is not a
    // failure worth propagating.
    const { instance } = uploader([ticketOk, putOk, confirmOk], {
      removeImpl: async () => {
        throw new Error('EBUSY');
      },
    });
    const result = await instance.upload({ jobId: JOB, kind: 'trace', localPath, runId: 'run-1' });

    expect(result.ok).toBe(true);
    expect(result.retained).toBe(true);
  });
});
