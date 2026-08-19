import { NextResponse } from 'next/server';
import { getStoreAsync } from '@/lib/store';
import { isPartnerRequest, partnerUnauthorised } from '@/server/partner-auth';

/** Ingest does a little database work and no browsing. */
export const maxDuration = 30;

/**
 * The Outskill Hackathon product submitting a product to be judged.
 *
 * Everything the Judge needs and nothing else. Team member names, emails and
 * phone numbers are not accepted, because none of them help decide whether a
 * product works — and the shortest honest answer to "why do you hold this" is
 * not to hold it.
 *
 * Safe to retry. Delivery is keyed on the Hackathon product's own immutable
 * submission id, so a repeat returns the same assessment with `duplicate: true`
 * rather than judging the same work twice.
 */
export async function POST(request: Request) {
  if (!isPartnerRequest(request)) return partnerUnauthorised();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const required = [
    'externalCohortId',
    'externalSubmissionId',
    'groupNumber',
    'productName',
    'mainUserAction',
    'productUrl',
    'accessMode',
  ] as const;
  const missing = required.filter((key) => body[key] === undefined || body[key] === null || body[key] === '');
  if (missing.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Missing required field(s): ${missing.join(', ')}.` },
      { status: 400 },
    );
  }

  if (body.accessMode !== 'open' && body.accessMode !== 'credentials') {
    return NextResponse.json(
      { ok: false, error: 'accessMode must be "open" or "credentials".' },
      { status: 400 },
    );
  }

  const store = await getStoreAsync();
  if (!store.partner) {
    return NextResponse.json(
      { ok: false, error: 'This deployment cannot accept partner submissions.' },
      { status: 503 },
    );
  }

  const result = await store.partner.ingestSubmission({
    externalCohortId: String(body.externalCohortId),
    externalSubmissionId: String(body.externalSubmissionId),
    groupNumber: Number(body.groupNumber),
    ideaSlug: String(body.ideaSlug ?? ''),
    productName: String(body.productName),
    briefDescription: String(body.briefDescription ?? ''),
    mainUserAction: String(body.mainUserAction),
    aiValue: String(body.aiValue ?? ''),
    productUrl: String(body.productUrl),
    accessMode: body.accessMode,
    judgeCredentials: (body.judgeCredentials ?? null) as never,
    loomUrl: body.loomUrl ? String(body.loomUrl) : null,
    deckUrl: body.deckUrl ? String(body.deckUrl) : null,
    submittedAt: body.submittedAt ? String(body.submittedAt) : null,
    submissionVersion: body.submissionVersion ? Number(body.submissionVersion) : null,
  });

  // 422 rather than 500: a refusal here is a fact about the payload, and the
  // caller's correct response is to fix it rather than retry unchanged.
  if (!result.ok) return NextResponse.json(result, { status: 422 });

  return NextResponse.json(result, {
    status: result.duplicate ? 200 : 201,
    headers: { 'cache-control': 'no-store' },
  });
}
