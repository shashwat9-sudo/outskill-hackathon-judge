import { NextResponse } from 'next/server';
import { isEvidenceKind } from '@ohj/shared/client';
import { getStoreAsync } from '@/lib/store';
import { auditAdminAction, getAdminSession } from '@/server/admin-auth';

/** Bounded by the size of a trace and the link to Storage, not by our work. */
export const maxDuration = 60;

/**
 * A judge opening the evidence behind a browser run.
 *
 * Until now the submission page printed a storage path as plain text and
 * nothing served the file, so a reviewer could see that a screenshot existed
 * and not look at it — the same gap the pitch deck had, with the same cost: a
 * human being asked to trust a score without being shown what it was based on.
 *
 * Three things this route is careful about.
 *
 * The buckets stay private. A signed URL is minted server-side, used here, and
 * discarded; it never reaches the browser, so there is no link to forward and
 * nothing for a proxy to cache.
 *
 * The caller names a run or a step, never a file. The bucket and path are read
 * from the database row that owns them. A route that accepted a storage path
 * would be treating that path as an authorisation, and paths are exactly the
 * sort of thing that ends up in a log, a screenshot or a support ticket.
 *
 * Learners never reach this. It is behind the admin session, and an
 * unauthenticated caller gets a 404 rather than a 401, because whether a given
 * run id exists is not something an anonymous request should be able to learn.
 */

/** Long enough to fetch the object, short enough that a leaked URL is dead. */
const SIGNED_URL_SECONDS = 300;

function storageFailure() {
  return NextResponse.json(
    {
      error: 'That evidence could not be retrieved.',
      detail:
        'The record points at an object Storage did not return. The run happened; the file is missing.',
    },
    { status: 502 },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const session = await getAdminSession();
  if (!session) return new NextResponse('Not found', { status: 404 });

  const { kind, id } = await params;
  if (!isEvidenceKind(kind)) return new NextResponse('Not found', { status: 404 });

  const store = await getStoreAsync();
  const object = await store.assessment.getEvidenceObject({ kind, id });

  if (!object) {
    // Distinguished from a broken link: for most steps there is genuinely no
    // screenshot, and the operator should not go looking for one.
    return NextResponse.json(
      {
        error: 'There is no stored evidence here.',
        detail:
          'Nothing was captured for this step, or the upload did not complete. This is not a broken link.',
      },
      { status: 404 },
    );
  }

  let upstream: Response;
  try {
    const signedUrl = await store.resources.getSignedUrl(
      object.bucket,
      object.storagePath,
      SIGNED_URL_SECONDS,
    );
    upstream = await fetch(signedUrl);
  } catch {
    return storageFailure();
  }

  if (!upstream.ok || !upstream.body) return storageFailure();

  await auditAdminAction({
    action: 'submission.evidence_accessed',
    entityType: 'submission',
    entityId: object.submissionId,
    cohortId: object.cohortId,
    after: { kind, jobId: object.jobId },
  });

  const wantsDownload = new URL(request.url).searchParams.get('download') === '1';
  const filename = object.storagePath.split('/').pop() ?? 'evidence';

  /*
   * Content type from us, not from upstream.
   *
   * A trace is a zip and a screenshot is a PNG; both are derived from the kind,
   * which the database chose. Echoing an upstream content type would let the
   * bytes in a bucket decide how this origin renders them.
   */
  const contentType = kind === 'trace' ? 'application/zip' : 'image/png';

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `${wantsDownload || kind === 'trace' ? 'attachment' : 'inline'}; filename="${filename}"`,
      // Evidence is somebody's work under assessment. It is not cached by
      // anything between here and the reviewer's browser.
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
    },
  });
}
