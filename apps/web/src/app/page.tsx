import Link from 'next/link';
import { getMemoryStore, isDemo } from '@/lib/store';
import { DEMO_TEAMS, demoTeamId } from '@ohj/shared';
import { Alert, Badge, Card, CardHeader, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Landing page.
 *
 * Deliberately thin. There is no public product here — participants arrive via
 * an invite link and the team arrives at /admin. In demo mode this page doubles
 * as the entry point for a walkthrough, listing the seeded invite links.
 */
export default async function HomePage() {
  const demo = isDemo();
  const memoryStore = demo ? getMemoryStore() : null;

  const invites = memoryStore
    ? DEMO_TEAMS.map((team) => ({
        groupNumber: team.groupNumber,
        scenario: team.scenario,
        productName: team.productName,
        token: memoryStore.getDemoInviteToken(demoTeamId(team.groupNumber)),
      }))
    : [];

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand">Outskill</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Hackathon Judge</h1>
      <p className="mt-3 max-w-prose text-lg text-muted">
        Internal platform for hackathon submission intake, evidence-backed automated assessment, and
        private shortlisting.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader
            title="Participants"
            description="Teams reach their submission through a private invite link. There is no account and no sign-in."
          />
          <p className="text-sm text-muted">
            If you are a participant, use the link the Outskill team sent you.
          </p>
        </Card>

        <Card>
          <CardHeader title="Outskill team" description="Cohorts, assessment, evidence and shortlisting." />
          <Link
            href="/admin"
            className="inline-flex items-center rounded-md bg-ink px-4 py-2 text-sm font-semibold text-surface hover:bg-ink-soft"
          >
            Open the admin dashboard
          </Link>
        </Card>
      </div>

      {demo && (
        <section className="mt-12" aria-labelledby="demo-heading">
          <h2 id="demo-heading" className="text-xl font-bold">
            Demo mode
          </h2>
          <Alert tone="info" className="mt-3">
            Running on deterministic fixtures — no database, no AI key, no worker required. All teams,
            products and contact details below are synthetic. Sign in to the admin dashboard with{' '}
            <code className="font-mono">outskill-admin</code> /{' '}
            <code className="font-mono">demo-admin-password</code>.
          </Alert>

          <Card className="mt-4">
            <CardHeader
              title="Seeded invite links"
              description="Six synthetic teams covering every scenario an operator needs to recognise."
              level={3}
            />
            <Table caption="Demo teams and their invite links">
              <thead>
                <tr>
                  <Th>Group</Th>
                  <Th>Product</Th>
                  <Th>Scenario</Th>
                  <Th>Invite</Th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.groupNumber}>
                    <Td className="font-mono">{invite.groupNumber}</Td>
                    <Td>{invite.productName}</Td>
                    <Td>
                      <Badge tone={SCENARIO_TONE[invite.scenario]}>
                        {invite.scenario.replace(/_/g, ' ')}
                      </Badge>
                    </Td>
                    <Td>
                      {invite.token ? (
                        <Link href={`/submit/${invite.token}`} className="font-medium text-brand underline">
                          Open submission
                        </Link>
                      ) : (
                        <span className="text-muted">revoked</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </section>
      )}
    </main>
  );
}

const SCENARIO_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  complete: 'success',
  incomplete: 'neutral',
  inaccessible: 'danger',
  login_required: 'info',
  manual_review: 'warning',
  low_confidence: 'warning',
};
