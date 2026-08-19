import { NextResponse } from 'next/server';
import { getStoreAsync } from '@/lib/store';
import { isPartnerRequest, partnerUnauthorised } from '@/server/partner-auth';

export const maxDuration = 30;

/**
 * What the internal product may read back for one submission.
 *
 * Addressed by cohort and submission together. The same submission identifier
 * can legitimately exist in two cohorts, and answering without knowing which
 * one would eventually mean showing a team another cohort's score.
 *
 * Returns scores, reasoning, flags and rank. Evidence, credentials, traces,
 * prompts and worker logs stay in the Judge.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ externalCohortId: string; externalSubmissionId: string }> },
) {
  if (!isPartnerRequest(request)) return partnerUnauthorised();

  const { externalCohortId, externalSubmissionId } = await params;
  const store = await getStoreAsync();
  if (!store.partner) {
    return NextResponse.json(
      { found: false, error: 'This deployment cannot serve partner results.' },
      { status: 503 },
    );
  }

  const result = await store.partner.getPartnerResult(externalCohortId, externalSubmissionId);
  if (!result.found) return NextResponse.json(result, { status: 404 });

  return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
}
