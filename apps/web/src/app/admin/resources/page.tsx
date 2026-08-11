import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Alert, Badge, Card, CardHeader, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Resource library.
 *
 * The only place where a stored file may be participant-visible — and it holds
 * templates and instructions, never assessment material. Assessment buckets are
 * private and reachable only through short-lived signed URLs.
 */
export default async function ResourcesPage() {
  await requireAdmin();
  const store = getStore();
  const resources = await store.resources.listResources(null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Resources</h1>

      <Alert tone="info">
        Participant-visible resources are limited to templates and instructions. Decks, screenshots,
        browser evidence, traces and internal reports live in private buckets and are never served
        from a participant route.
      </Alert>

      <Card>
        <CardHeader
          title="Documents"
          description="Marked visible resources appear on every participant's submission page for their cohort."
        />
        {resources.length === 0 ? (
          <p className="text-sm text-muted">No resources uploaded.</p>
        ) : (
          <Table caption="Resource documents">
            <thead>
              <tr>
                <Th>Title</Th>
                <Th>Kind</Th>
                <Th>Storage</Th>
                <Th>Size</Th>
                <Th>Visibility</Th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <tr key={resource.id}>
                  <Td>
                    <p className="font-medium">{resource.title}</p>
                    <p className="text-muted">{resource.description}</p>
                  </Td>
                  <Td>{resource.kind.replace(/_/g, ' ')}</Td>
                  <Td className="font-mono text-xs text-muted">
                    {resource.storageBucket}/{resource.storagePath}
                  </Td>
                  <Td>{(resource.byteSize / 1024 / 1024).toFixed(1)} MB</Td>
                  <Td>
                    {resource.isParticipantVisible ? (
                      <Badge tone="success">participants</Badge>
                    ) : (
                      <Badge tone="neutral">internal</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Storage buckets" description="All private. Access is via signed URLs only." />
        <Table caption="Storage buckets and their contents">
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th>Holds</Th>
              <Th>Participant-reachable</Th>
            </tr>
          </thead>
          <tbody>
            {[
              ['submission-decks', 'Uploaded PDF pitch decks', 'Own deck only, via their invite'],
              ['submission-screenshots', 'Screenshots captured during testing', 'No'],
              ['browser-evidence', 'Per-step browser evidence', 'No'],
              ['traces', 'Playwright traces', 'No'],
              ['internal-reports', 'Internal assessment reports', 'No'],
              ['admin-resources', 'Templates and instructions', 'Only where marked visible'],
            ].map(([bucket, holds, reachable]) => (
              <tr key={bucket}>
                <Td className="font-mono">{bucket}</Td>
                <Td>{holds}</Td>
                <Td className={reachable === 'No' ? 'font-semibold' : undefined}>{reachable}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
