import { timingSafeEqual } from 'node:crypto';
import { getEnvConfig } from '@/lib/store';

/**
 * Who may hand us work to judge.
 *
 * One caller: the Outskill Hackathon product, over a server-to-server call. Its
 * credential is deliberately not `WORKER_API_TOKEN` — that one authorises the
 * judging worker to upload evidence for a job it holds, which is a different
 * capability granted to a different process. One secret for both would mean a
 * leak on either side handing over everything, and no way to rotate one without
 * breaking the other.
 *
 * Fails shut. A missing or too-short token means nobody is authorised, rather
 * than everybody: a deployment that forgot to set it should refuse work, not
 * accept it from anyone who asks.
 */
export function isPartnerRequest(request: Request): boolean {
  const expected = getEnvConfig().PARTNER_API_TOKEN;
  if (!expected || expected.length < 32) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) return false;

  // Constant time, so a caller cannot learn the token one byte at a time.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The refusal.
 *
 * 404 rather than 401: whether this endpoint exists is not something an
 * unauthenticated caller should be able to confirm.
 */
export function partnerUnauthorised(): Response {
  return new Response('Not found', { status: 404 });
}
