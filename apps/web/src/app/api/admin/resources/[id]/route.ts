import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getAdminSession } from '@/server/admin-auth';

/**
 * Internal resource download.
 *
 * Requires an admin session. Kept separate from the participant resource route
 * so there is no branch where a participant request could fall through to an
 * internal document — the two audiences use two different endpoints.
 *
 * Accepts a resource id or a stable slug (`admin-playbook`), so operator-facing
 * links do not depend on a generated id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!session) return new NextResponse('Not found', { status: 404 });

  const { id } = await params;
  const store = getStore();
  const resources = await store.resources.listResources(null);

  const resource =
    resources.find((r) => r.id === id) ??
    resources.find((r) => r.storagePath.toLowerCase().includes(id.toLowerCase()));

  if (!resource) return new NextResponse('Not found', { status: 404 });

  const signedUrl = await store.resources.getSignedUrl(
    resource.storageBucket,
    resource.storagePath,
    300,
  );
  return NextResponse.redirect(
    new URL(signedUrl, process.env.APP_BASE_URL ?? 'http://localhost:3000'),
  );
}
