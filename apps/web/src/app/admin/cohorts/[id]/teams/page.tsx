import { notFound } from 'next/navigation';
import { getEnvConfig, getMemoryStore, getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  exportInvitesAction,
  importTeamsAction,
  regenerateInviteAction,
  revokeInviteAction,
} from '@/server/admin-actions';
import { AdminForm, DownloadButton } from '@/components/admin-form';
import { Alert, Badge, Card, CardHeader, Field, Table, Td, Textarea, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const store = getStore();
  const memory = getMemoryStore();
  const env = getEnvConfig();

  const cohort = await store.cohorts.getCohort(id);
  if (!cohort) notFound();
  const teams = await store.teams.listTeams(id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Teams and invites</h1>
        <p className="text-sm text-muted">
          {cohort.name} · one invite link per team. Only the hash of a token is stored, so a link
          cannot be recovered from the database — regenerate instead.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Import teams"
          description="Upload or paste a CSV with group number, lead name, lead email and lead phone. Column headings are matched flexibly."
        />
        <AdminForm action={importTeamsAction} csrfToken={session.csrfToken} submitLabel="Import teams">
          <input type="hidden" name="cohortId" value={cohort.id} />
          <div className="space-y-4">
            <div>
              <label htmlFor="csv" className="block text-sm font-semibold">
                CSV file
              </label>
              <input id="csv" name="csv" type="file" accept=".csv,text/csv" className="mt-1 text-sm" />
            </div>
            <Field id="csvText" label="…or paste CSV" hint="Include a header row.">
              {(aria) => (
                <Textarea
                  {...aria}
                  name="csvText"
                  rows={4}
                  className="font-mono text-sm"
                  placeholder={'Group Number,Lead Name,Lead Email,Lead Phone\n101,Priya,priya@example.com,+91 98765 43210'}
                />
              )}
            </Field>
          </div>
        </AdminForm>
      </Card>

      <Card>
        <CardHeader
          title={`Teams (${teams.length})`}
          description="Distribute invite links through your own channel — this platform sends no email (ADR-024)."
          actions={
            <DownloadButton
              label="Download invite CSV"
              filename={`invites-${cohort.code}.csv`}
              action={exportInvitesAction}
              arg={cohort.id}
            />
          }
        />

        {teams.length === 0 ? (
          <p className="text-sm text-muted">No teams imported yet.</p>
        ) : (
          <Table caption="Teams and their invite status">
            <thead>
              <tr>
                <Th>Group</Th>
                <Th>Lead</Th>
                <Th>Members</Th>
                <Th>Invite</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const token = memory?.getDemoInviteToken(team.id) ?? null;
                const revoked = team.invite?.revokedAt;
                return (
                  <tr key={team.id}>
                    <Td className="font-mono font-semibold">{team.groupNumber}</Td>
                    <Td>
                      <p>{team.leadName}</p>
                      <p className="text-muted">{team.leadEmail}</p>
                    </Td>
                    <Td>{team.members.length}</Td>
                    <Td>
                      {revoked ? (
                        <Badge tone="danger">revoked</Badge>
                      ) : team.invite ? (
                        <div>
                          <Badge tone="success">active</Badge>
                          <p className="mt-1 font-mono text-xs text-muted">
                            {team.invite.tokenPrefix}… · {team.invite.accessCount} opens
                          </p>
                          {token && (
                            <a
                              href={`${env.APP_BASE_URL}/submit/${token}`}
                              className="text-xs text-brand underline"
                            >
                              Open link
                            </a>
                          )}
                        </div>
                      ) : (
                        <Badge tone="neutral">none</Badge>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-2">
                        <AdminForm
                          action={regenerateInviteAction}
                          csrfToken={session.csrfToken}
                          submitLabel="Regenerate"
                          submitVariant="secondary"
                          confirm={`Regenerate the invite for group ${team.groupNumber}? The current link stops working immediately.`}
                        >
                          <input type="hidden" name="teamId" value={team.id} />
                          <input type="hidden" name="cohortId" value={cohort.id} />
                        </AdminForm>
                        {!revoked && (
                          <AdminForm
                            action={revokeInviteAction}
                            csrfToken={session.csrfToken}
                            submitLabel="Revoke"
                            submitVariant="ghost"
                            confirm={`Revoke the invite for group ${team.groupNumber}? They will lose access to their submission.`}
                          >
                            <input type="hidden" name="teamId" value={team.id} />
                            <input type="hidden" name="cohortId" value={cohort.id} />
                          </AdminForm>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Alert tone="info">
        Invite links are the only participant credential. Treat the invite CSV as sensitive — anyone
        holding a link can edit that team&apos;s submission while the cohort is open.
      </Alert>
    </div>
  );
}
