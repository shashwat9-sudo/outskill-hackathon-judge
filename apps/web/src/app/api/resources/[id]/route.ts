import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

/**
 * Participant-visible resource download.
 *
 * Only resources explicitly marked participant-visible are served, and only
 * through a short-lived signed URL. There is no code path here that can reach
 * an assessment bucket — the check is on the resource record, and assessment
 * material is never recorded as a resource.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const store = getStore();

  const resources = await store.resources.listResources(null);
  const resource = resources.find((r) => r.id === id);

  if (!resource || !resource.isParticipantVisible) {
    // Same response for "does not exist" and "not visible", so this cannot be
    // used to probe for internal documents.
    return new NextResponse('Not found', { status: 404 });
  }

  const signedUrl = await store.resources.getSignedUrl(resource.storageBucket, resource.storagePath, 300);
  return NextResponse.redirect(new URL(signedUrl, process.env.APP_BASE_URL ?? 'http://localhost:3000'));
}
