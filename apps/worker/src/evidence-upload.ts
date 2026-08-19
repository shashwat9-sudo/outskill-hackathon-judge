import { readFile, stat, unlink } from 'node:fs/promises';
import type { EvidenceKind } from '@ohj/shared/client';

/**
 * Getting captured evidence off the worker's disk.
 *
 * The worker writes screenshots and traces to a local directory, which was fine
 * on a laptop and is a lie in a container: the file disappears on the next
 * deploy and the database row keeps pointing at it. A row that claims evidence
 * which is not there is the same defect as F-7 in different clothes.
 *
 * So the worker no longer records where it put a file. It asks the web app for
 * permission to write one object, uploads to that one place, and asks the web
 * app to confirm. The web app checks the bucket before writing anything down.
 * The worker holds no Storage credential at any point — the signed URL it gets
 * back can write to exactly one path and expires in minutes.
 *
 * The local file is deleted only after a confirmation succeeds. Everything else
 * — a refusal, a timeout, a crash — leaves the bytes on disk, because evidence
 * we still have is worth more than a tidy directory.
 */

export interface EvidenceUploadResult {
  ok: boolean;
  /** Where it now lives, for the caller to record. Absent unless ok. */
  storagePath?: string;
  bucket?: string;
  /** Why it did not happen, for the log. Never shown to a learner. */
  reason?: string;
  /** True when the bytes are still on local disk and could be retried. */
  retained?: boolean;
}

export interface EvidenceUploader {
  upload(input: {
    jobId: string;
    kind: EvidenceKind;
    localPath: string;
    /** The browser run a trace belongs to. */
    runId?: string | null;
    /** The step a screenshot belongs to. */
    stepId?: string | null;
  }): Promise<EvidenceUploadResult>;
}

export interface EvidenceUploaderOptions {
  /** The web app's base URL. The worker talks to it, not to Storage. */
  baseUrl: string;
  /** Shared secret proving this caller is our worker. Never logged. */
  token: string;
  workerId: string;
  /** How many times to try the whole ticket→PUT→confirm sequence. */
  maxAttempts?: number;
  /** Base backoff between attempts, in milliseconds. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Deleting the local copy after a confirmed upload. Swappable for tests. */
  removeImpl?: (path: string) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * A refusal that will never succeed, however many times we ask.
 *
 * 409 means the store looked at the job and said no — wrong stage, expired
 * lease, superseded attempt. Retrying that is pointless and, in the superseded
 * case, is precisely the thing we do not want to keep attempting. 4xx generally
 * means we asked wrongly. Only 5xx and transport failures are worth another go.
 */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500;
}

export function createEvidenceUploader(options: EvidenceUploaderOptions): EvidenceUploader {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const remove = options.removeImpl ?? unlink;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const base = options.baseUrl.replace(/\/+$/, '');

  /** What the web app sends back. Every field is checked before it is used. */
  interface JsonResponse {
    status: number;
    json: {
      ok?: boolean;
      error?: string;
      uploadUrl?: string;
      bucket?: string;
      storagePath?: string;
      maxBytes?: number;
      contentType?: string;
      attempt?: number;
    } | null;
  }

  async function post(path: string, body: unknown): Promise<JsonResponse> {
    const response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The only place the token appears. Never in a URL, never in a log.
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
    });
    let json: JsonResponse['json'] = null;
    try {
      json = (await response.json()) as JsonResponse['json'];
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** One full attempt. Returns null when it is worth trying again. */
  async function attempt(input: {
    jobId: string;
    kind: EvidenceKind;
    localPath: string;
    filename: string;
    bytes: Uint8Array;
    runId?: string | null;
    stepId?: string | null;
  }): Promise<EvidenceUploadResult | null> {
    const ticket = await post('/api/internal/worker/evidence/upload-ticket', {
      jobId: input.jobId,
      kind: input.kind,
      filename: input.filename,
      workerId: options.workerId,
    });

    if (ticket.status !== 200 || !ticket.json?.ok) {
      const reason = String(ticket.json?.error ?? `Ticket refused (${ticket.status}).`);
      return isPermanent(ticket.status) ? { ok: false, reason, retained: true } : null;
    }

    // Checked before sending rather than after: the server would refuse an
    // oversized object anyway, and there is no reason to spend the bandwidth.
    const maxBytes = Number(ticket.json.maxBytes ?? 0);
    if (maxBytes > 0 && input.bytes.byteLength > maxBytes) {
      return {
        ok: false,
        reason: `${input.filename} is ${input.bytes.byteLength} bytes; the limit for a ${input.kind} is ${maxBytes}.`,
        retained: true,
      };
    }

    /*
     * Straight to Storage, with a URL that can write one path.
     *
     * This is the only request in the worker that does not go to the web app,
     * and it carries no credential of ours — the authorisation is inside the
     * signed URL and expires in minutes. The worker's token must not be
     * attached here: it would be sent to a host we do not control.
     */
    let putStatus: number;
    try {
      const put = await doFetch(String(ticket.json.uploadUrl), {
        method: 'PUT',
        /*
         * The content type comes from the ticket, not from us.
         *
         * Each bucket has an allow-list, and a PUT without this header arrives
         * as `application/octet-stream` and is refused with a 415 — which is
         * how every upload failed on the first real run: valid bytes, valid
         * URL, and Storage declining to say why in any way the worker surfaced.
         */
        headers: ticket.json.contentType ? { 'content-type': ticket.json.contentType } : {},
        body: Buffer.from(input.bytes),
      });
      putStatus = put.status;
    } catch (error) {
      // Transport failure. Bytes are still on disk; try again.
      void error;
      return null;
    }
    if (putStatus < 200 || putStatus >= 300) {
      // A signed URL that has expired reads as a 4xx here. Re-ticketing is
      // exactly the right response, so this is a retry, not a failure.
      return null;
    }

    const confirmed = await post('/api/internal/worker/evidence/confirm', {
      jobId: input.jobId,
      kind: input.kind,
      bucket: ticket.json.bucket,
      storagePath: ticket.json.storagePath,
      workerId: options.workerId,
      attempt: ticket.json.attempt,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
    });

    if (confirmed.status !== 200 || !confirmed.json?.ok) {
      const reason = String(confirmed.json?.error ?? `Confirmation refused (${confirmed.status}).`);
      return isPermanent(confirmed.status) ? { ok: false, reason, retained: true } : null;
    }

    /*
     * Confirmed, and only now is the local copy expendable.
     *
     * The order matters more than it looks. Deleting before confirmation — or
     * on a failure, to free space — would turn a retryable upload into
     * permanently lost evidence. A confirmation means the web app asked Storage
     * and Storage said the object is there.
     *
     * A failed delete is not a failed upload. The evidence is durable either
     * way; the worst case is a stale file in a container that is about to be
     * replaced.
     */
    let retained = false;
    try {
      await remove(input.localPath);
    } catch {
      retained = true;
    }

    return {
      ok: true,
      bucket: String(ticket.json.bucket),
      storagePath: String(ticket.json.storagePath),
      retained,
    };
  }

  return {
    async upload({ jobId, kind, localPath, runId, stepId }) {
      const filename = localPath.split('/').pop() ?? 'evidence';

      // Read once, outside the retry loop: a file that is not there cannot be
      // uploaded on the third attempt either.
      let bytes: Uint8Array;
      try {
        const info = await stat(localPath);
        if (!info.isFile() || info.size === 0) {
          return { ok: false, reason: `${filename} is empty or not a file.`, retained: false };
        }
        bytes = await readFile(localPath);
      } catch {
        return { ok: false, reason: `${filename} could not be read from local disk.`, retained: false };
      }

      let lastReason = 'Upload did not complete.';
      for (let i = 0; i < maxAttempts; i += 1) {
        const result = await attempt({ jobId, kind, localPath, filename, bytes, runId, stepId });
        if (result) {
          if (!result.ok) lastReason = result.reason ?? lastReason;
          return result;
        }
        if (i < maxAttempts - 1) await sleep(retryDelayMs * (i + 1));
      }

      // Out of attempts. The bytes are still on disk and the database still
      // says there is no evidence, which is true.
      return { ok: false, reason: lastReason, retained: true };
    },
  };
}
