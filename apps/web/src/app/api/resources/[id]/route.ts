import { NextResponse } from 'next/server';
import { getEnvConfig, getStoreAsync } from '@/lib/store';

/**
 * How long this may run on a serverless host.
 *
 * Streams a resource file, which can be as large as a deck template.
 */
export const maxDuration = 60;

/**
 * Participant-visible resource download.
 *
 * Only resources explicitly marked participant-visible are served, and only
 * through a short-lived signed URL. There is no code path here that can reach
 * an assessment bucket — the check is on the resource record, and assessment
 * material is never recorded as a resource.
 *
 * Accepts a resource id, or one of two stable aliases so the learner portal can
 * link to the template without knowing a generated id.
 */
const KIND_ALIASES: Record<string, string> = {
  'pitch-template': 'pitch_template',
  instructions: 'instructions',
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await getStoreAsync();

  const resources = await store.resources.listResources(null);
  const aliasKind = KIND_ALIASES[id];
  const resource = aliasKind
    ? resources.find((r) => r.kind === aliasKind && r.isParticipantVisible)
    : resources.find((r) => r.id === id);

  if (!resource || !resource.isParticipantVisible) {
    // Identical response for "does not exist" and "not visible", so this cannot
    // be used to probe for internal documents.
    return new NextResponse('Not found', { status: 404 });
  }

  const signedUrl = await store.resources.getSignedUrl(
    resource.storageBucket,
    resource.storagePath,
    300,
  );
  return NextResponse.redirect(
    // Resolved through the validated config, not a second hardcoded default:
    // two sources for one value is how they drift apart.
    new URL(signedUrl, getEnvConfig().APP_BASE_URL),
  );
}
