import { NextResponse } from 'next/server';
import { getStoreAsync } from '@/lib/store';
import { auditAdminAction, getAdminSession } from '@/server/admin-auth';

/**
 * How long this may run on a serverless host.
 *
 * Streams a whole deck through the function, so it is bounded by the size of
 * the PDF and the link to Storage rather than by any work we do.
 */
export const maxDuration = 60;

/**
 * A judge opening a team's pitch deck.
 *
 * Without this the deck is unreachable: the bucket is private, the submission
 * page showed only a storage path as plain text, and no route served an
 * artifact. A reviewer looking at a flagged submission had a PDF they could
 * see the existence of and not read.
 *
 * The bucket stays private. A short-lived signed URL is minted per request and
 * the caller is redirected to it, so there is never a durable public link and
 * nothing is cached by a proxy. Five minutes is enough to open or download a
 * file and short enough that a URL pasted into a chat is dead before anyone
 * reads it.
 *
 * Every request is audited. A learner's deck is their work, and who looked at
 * it — and when — is worth being able to answer.
 */

/** Long enough to open a PDF, short enough that a leaked URL is already dead. */
const SIGNED_URL_SECONDS = 300;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // A 404 rather than a 401 for an unauthenticated caller: whether a given
  // submission id exists is not something an anonymous request should learn.
  const session = await getAdminSession();
  if (!session) return new NextResponse('Not found', { status: 404 });

  const { id } = await params;
  const store = await getStoreAsync();

  const detail = await store.submissions.getSubmissionDetail(id);
  if (!detail) return new NextResponse('Not found', { status: 404 });

  const deck = detail.artifacts.find((artifact) => artifact.kind === 'deck_pdf');
  if (!deck || !deck.storageBucket || !deck.storagePath) {
    // Distinguished from "no such submission": the operator needs to know the
    // team never uploaded one, not go looking for a broken link.
    return NextResponse.json(
      {
        error: 'This submission has no pitch deck.',
        detail:
          'The team did not upload one, or it was removed. There is nothing to open — this is not a broken link.',
      },
      { status: 404 },
    );
  }

  const wantsDownload = new URL(request.url).searchParams.get('download') === '1';

  /**
   * Streamed through this route, not redirected to Storage.
   *
   * Redirecting handed the browser a cross-origin signed URL, and from there
   * the outcome was Supabase's to decide: the tab navigated away to a PDF
   * viewer, "Download" behaved exactly like "View", and the operator lost the
   * submission page they were working from. `Content-Disposition` on somebody
   * else's response is not something this application can set.
   *
   * Streaming keeps the decision here. The signed URL is created, used and
   * discarded server-side and never reaches the browser at all, which also
   * means there is no URL to forward.
   */
  let upstream: Response;
  try {
    const signedUrl = await store.resources.getSignedUrl(
      deck.storageBucket,
      deck.storagePath,
      SIGNED_URL_SECONDS,
    );
    upstream = await fetch(signedUrl);
  } catch {
    return storageFailure();
  }

  if (!upstream.ok || !upstream.body) {
    // The row says a file exists and Storage disagrees — the signature of an
    // upload recorded as a success that stored nothing (F-7).
    return storageFailure();
  }

  await auditAdminAction({
    action: 'submission.deck_accessed',
    entityType: 'submission',
    entityId: id,
    cohortId: detail.submission.cohortId,
    // The path, never a URL — a signed URL in an audit log is a live credential.
    after: {
      groupNumber: detail.team.groupNumber,
      storagePath: deck.storagePath,
      mode: wantsDownload ? 'download' : 'view',
    },
  });

  const filename = downloadFilename(detail.team.groupNumber, deck.originalFilename);

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      // The whole point of the two buttons: one opens, one saves.
      'content-disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
      // Judging material must never sit in a shared cache.
      'cache-control': 'private, no-store, no-cache, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * A filename an operator can find again.
 *
 * Every deck is stored as `pitch-deck.pdf`, so downloading three of them gives
 * three files with the same name. The group number is what a reviewer actually
 * has in front of them.
 */
function downloadFilename(groupNumber: number, originalFilename: string | null): string {
  const base = (originalFilename ?? 'pitch-deck.pdf')
    .replace(/\.pdf$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `group-${groupNumber}-${base || 'pitch-deck'}.pdf`;
}

function storageFailure(): Response {
  return NextResponse.json(
    {
      error: 'The deck is recorded but its file could not be found in storage.',
      detail:
        'The submission has an artifact record with no object behind it. Check the upload before judging this submission.',
    },
    { status: 502 },
  );
}
