import { NextResponse } from 'next/server';
import { getStoreAsync } from '@/lib/store';
import { isPartnerRequest, partnerUnauthorised } from '@/server/partner-auth';

export const maxDuration = 30;

/**
 * Map one of the internal product's cohorts onto a Judge cohort.
 *
 * Ops should not have to recreate cohorts by hand in the Judge admin, so the
 * internal product declares them — once, over an authenticated call, before
 * submissions arrive.
 *
 * Declared rather than inferred from the first submission. A cohort decides
 * which ranking a team competes in and which private Top 10 they can reach, so
 * a mistyped identifier should fail at the door rather than quietly open a
 * second competition with one entrant in it. A cohort also needs dates, a
 * rubric and a shortlist target that no submission payload carries.
 *
 * Idempotent: safe to call on every deploy. The mapping from external id to
 * Judge uuid never moves once established.
 */
export async function POST(request: Request) {
  if (!isPartnerRequest(request)) return partnerUnauthorised();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  if (!body.externalCohortId || !body.name) {
    return NextResponse.json(
      { ok: false, error: 'externalCohortId and name are required.' },
      { status: 400 },
    );
  }

  const store = await getStoreAsync();
  if (!store.partner) {
    return NextResponse.json(
      { ok: false, error: 'This deployment cannot accept partner cohorts.' },
      { status: 503 },
    );
  }

  const result = await store.partner.syncCohort({
    externalCohortId: String(body.externalCohortId),
    name: String(body.name),
    code: body.code ? String(body.code) : undefined,
    day12StartAt: body.day12StartAt ? String(body.day12StartAt) : null,
    day13DeadlineAt: body.day13DeadlineAt ? String(body.day13DeadlineAt) : null,
    shortlistTarget: body.shortlistTarget ? Number(body.shortlistTarget) : null,
  });

  if (!result.ok) return NextResponse.json(result, { status: 422 });

  return NextResponse.json(result, {
    status: result.created ? 201 : 200,
    headers: { 'cache-control': 'no-store' },
  });
}
