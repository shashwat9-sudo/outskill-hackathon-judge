import { getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Badge, Card, CardHeader, PageHeading } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Resource library.
 *
 * Downloads, not implementation detail. Storage bucket names and private paths
 * live under Settings → Advanced → Storage diagnostics, where they belong —
 * an operator looking for the pitch-deck template should not have to read a
 * bucket policy to find it.
 */
export default async function ResourcesPage() {
  await requireAdmin();
  const store = await getStoreAsync();
  const resources = await store.resources.listResources(null);

  const participant = resources.filter((r) => r.isParticipantVisible);
  const internal = resources.filter((r) => !r.isParticipantVisible);

  return (
    <div>
      <PageHeading
        title="Resources"
        description="Templates and guides for participants, and operating documents for the Outskill team."
      />

      <ResourceGroup
        title="Participant resources"
        description="Shown on every team's submission page for this cohort."
        audience="Participants"
        resources={participant}
      />

      <ResourceGroup
        title="Admin resources"
        description="Internal operating documents. Never shown to participants."
        audience="Internal"
        resources={internal}
        tone="internal"
      />
    </div>
  );
}

function ResourceGroup({
  title,
  description,
  audience,
  resources,
  tone = 'participant',
}: {
  title: string;
  description: string;
  audience: string;
  resources: {
    id: string;
    title: string;
    description: string;
    mimeType: string;
    byteSize: number;
  }[];
  tone?: 'participant' | 'internal';
}) {
  return (
    <section className="mb-10">
      <CardHeader title={title} description={description} />

      {resources.length === 0 ? (
        <p className="text-sm text-muted">Nothing here yet.</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {resources.map((resource) => (
            <li key={resource.id}>
              <Card className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3">
                  <span aria-hidden="true" className="text-2xl">
                    {fileIcon(resource.mimeType)}
                  </span>
                  <Badge tone={tone === 'internal' ? 'neutral' : 'accent'}>{audience}</Badge>
                </div>

                <h3 className="mt-3 font-bold text-ink">{resource.title}</h3>
                <p className="mt-1.5 flex-1 text-sm text-muted">{resource.description}</p>

                <p className="mt-4 font-mono text-xs text-muted">
                  {fileLabel(resource.mimeType)} · {formatSize(resource.byteSize)}
                </p>

                <a
                  href={
                    tone === 'internal'
                      ? `/api/admin/resources/${resource.id}`
                      : `/api/resources/${resource.id}`
                  }
                  className="mt-4 inline-flex items-center justify-center rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
                >
                  {resource.mimeType === 'text/html' ? 'Open' : 'Download'}
                </a>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fileIcon(mimeType: string): string {
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('presentation')) return '📊';
  if (mimeType.includes('html')) return '🖥';
  if (mimeType.includes('markdown')) return '📘';
  return '📄';
}

function fileLabel(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'PDF';
  if (mimeType.includes('presentation')) return 'PowerPoint';
  if (mimeType.includes('html')) return 'Web page';
  if (mimeType.includes('markdown')) return 'Markdown';
  return 'File';
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
