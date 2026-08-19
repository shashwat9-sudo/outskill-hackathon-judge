import { NextResponse } from 'next/server';
import { getStoreAsync } from '@/lib/store';
import { isPartnerRequest, partnerUnauthorised } from '@/server/partner-auth';

export const maxDuration = 30;

/**
 * What the Hackathon product may read back.
 *
 * Scores, reasoning, flags and rank — everything needed to show a team where
 * they stand, and nothing that would leak how the sausage was made. No worker
 * logs, no evidence objects, no credentials, no prompts, no model output beyond
 * the reasoning already written for a human.
 *
 * The evidence itself stays in the Judge. A reviewer looks at it here, through
 * the admin routes, behind an admin session.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> },
) {
  if (!isPartnerRequest(request)) return partnerUnauthorised();

  const { externalId } = await params;
  const store = await getStoreAsync();
  if (!store.partner) {
    return NextResponse.json(
      { found: false, error: 'This deployment cannot serve partner results.' },
      { status: 503 },
    );
  }

  const result = await store.partner.getPartnerResult(externalId);
  if (!result.found) return NextResponse.json(result, { status: 404 });

  return NextResponse.json(result, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
