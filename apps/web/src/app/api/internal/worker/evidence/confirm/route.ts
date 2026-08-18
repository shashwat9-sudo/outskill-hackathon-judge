import { NextResponse } from 'next/server';
import { isEvidenceKind } from '@ohj/shared/client';
import { getStoreAsync } from '@/lib/store';
import { isWorkerRequest, workerUnauthorised } from '@/server/worker-auth';

export const maxDuration = 30;

/**
 * Take delivery of an evidence upload, or refuse it.
 *
 * The store reconstructs the path it would have issued, asks Storage whether
 * the object is actually there, and only then records anything. Until this
 * returns ok, the database says no evidence exists — which is the truth.
 *
 * Idempotent: a retry re-uploads to the same derived path and lands here again,
 * setting a column to the value it already holds.
 */
export async function POST(request: Request) {
  if (!isWorkerRequest(request)) return workerUnauthorised();

  let body: {
    jobId?: string;
    kind?: string;
    bucket?: string;
    storagePath?: string;
    workerId?: string;
    attempt?: number;
    runId?: string | null;
    stepId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const { jobId, kind, bucket, storagePath, workerId, attempt, runId, stepId } = body;
  if (!jobId || !kind || !bucket || !storagePath || !workerId) {
    return NextResponse.json({ ok: false, error: 'Missing field.' }, { status: 400 });
  }
  // The attempt the ticket was issued under. Required, and required to be a
  // number: a missing one must not silently become attempt 0 and match a job
  // that has never been claimed.
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
    return NextResponse.json({ ok: false, error: 'Missing or invalid attempt.' }, { status: 400 });
  }
  if (!isEvidenceKind(kind)) {
    return NextResponse.json({ ok: false, error: 'Unknown evidence kind.' }, { status: 400 });
  }

  const store = await getStoreAsync();
  const result = await store.assessment.confirmEvidenceUpload({
    jobId,
    kind,
    bucket,
    storagePath,
    workerId,
    attempt,
    runId: runId ?? null,
    stepId: stepId ?? null,
  });

  // 409 rather than 500: a refusal here is a fact about the upload, and the
  // worker's correct response is to keep its local copy and retry.
  if (!result.ok) return NextResponse.json(result, { status: 409 });

  return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
}
