import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { getEnvConfig } from '@/lib/store';

/**
 * Is this request from our judging worker?
 *
 * The worker runs on a different host and holds no Storage credential, so it
 * asks the web app for one upload authorisation at a time. This proves the
 * caller is the worker.
 *
 * It proves nothing else. The token is not a capability: every route that
 * accepts it re-checks the job being named, the job's state, its lease, and
 * derives the storage path itself. A leaked token would let someone ask for an
 * upload URL for a job — not choose where it points, and not read anything.
 */
export function isWorkerRequest(request: Request): boolean {
  const expected = getEnvConfig().WORKER_API_TOKEN;

  // No token configured means the endpoint is closed, not open. A deployment
  // that forgot to set it must fail shut.
  if (!expected || expected.length < 32) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) return false;

  // Constant time, and length-safe: `timingSafeEqual` throws on a length
  // mismatch, which would itself leak the length.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A refusal that says nothing about why. */
export function workerUnauthorised(): Response {
  return new Response('Not found', { status: 404 });
}
