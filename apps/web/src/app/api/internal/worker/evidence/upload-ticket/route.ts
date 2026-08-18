import { NextResponse } from 'next/server';
import { isEvidenceKind } from '@ohj/shared/client';
import { getStoreAsync } from '@/lib/store';
import { isWorkerRequest, workerUnauthorised } from '@/server/worker-auth';

export const maxDuration = 30;

/**
 * Permission to write one evidence object.
 *
 * The worker captures screenshots and traces on local disk and cannot put them
 * anywhere durable: it holds no Storage credential, deliberately. It asks here,
 * and gets back a URL that can write to exactly one path — chosen here, from
 * the job it named, never from anything it sent.
 *
 * The token proves the caller is our worker. The store does the rest: the job
 * must exist, its submission must belong to its cohort, it must be in a stage
 * where evidence may still be written, and its lease must not belong to
 * somebody else.
 */
export async function POST(request: Request) {
  if (!isWorkerRequest(request)) return workerUnauthorised();

  let body: { jobId?: string; kind?: string; filename?: string; workerId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const { jobId, kind, filename, workerId } = body;
  if (!jobId || !kind || !filename || !workerId) {
    return NextResponse.json({ ok: false, error: 'Missing field.' }, { status: 400 });
  }
  if (!isEvidenceKind(kind)) {
    return NextResponse.json({ ok: false, error: 'Unknown evidence kind.' }, { status: 400 });
  }

  const store = await getStoreAsync();
  const ticket = await store.assessment.createEvidenceUploadTicket({
    jobId,
    kind,
    filename,
    workerId,
  });

  // The refusal reason is safe to return: it names a job state, never a secret.
  if (!ticket.ok) return NextResponse.json(ticket, { status: 409 });

  return NextResponse.json(ticket, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
