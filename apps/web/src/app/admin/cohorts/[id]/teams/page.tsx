import { notFound } from 'next/navigation';
import { getDemoStore, getEnvConfig, getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  clearLockoutAction,
  exportInvitesAction,
  importTeamsAction,
  issueMissingCodesAction,
  regenerateOneCodeAction,
  rotateAllCodesAction,
  revokeAccessCodeAction,
  revokeInviteAction,
} from '@/server/admin-actions';
import { AdminForm, DownloadButton } from '@/components/admin-form';
import { LearnerImport } from './learner-import';
import { IssueCodesButton } from './issue-codes';
import { formatInTimezone } from '@ohj/shared';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  Field,
  Input,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const store = await getStoreAsync();
  const demo = getDemoStore();
  const env = getEnvConfig();

  const cohort = await store.cohorts.getCohort(id);
  if (!cohort) notFound();
  const teams = await store.teams.listTeams(id);
  const codes = await store.teams.listAccessCodeStatus(id);
  const codeByTeam = new Map(codes.map((row) => [row.teamId, row]));
  const withoutCode = codes.filter((row) => !row.hasCode || row.revokedAt).length;
  const lockedOut = codes.filter((row) => row.lockedUntil && row.lockedUntil > new Date());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Teams and access</h1>
        <p className="text-sm text-muted">
          {cohort.name} · teams reach one common submission URL and identify themselves with their
          group number and access code. Only the hash of a code is stored, so a code cannot be
          recovered from the database — issue a new one instead.
        </p>
      </div>

      <AccessCodeSection
        cohort={cohort}
        codes={codes}
        withoutCode={withoutCode}
        lockedOut={lockedOut}
        csrfToken={session.csrfToken}
        submitUrl={`${env.APP_BASE_URL}/submit`}
      />

      <LearnerImport
        cohortId={cohort.id}
        csrfToken={session.csrfToken}
        existingGroupNumbers={teams.map((t) => t.groupNumber)}
      />

      <details className="rounded border border-subtle p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Manual CSV import (group number, lead name, lead email, lead phone)
        </summary>
        <p className="mt-2 text-sm text-muted">
          The older format, kept for a cohort that does not come from the allocation sheet. It
          requires a named team lead; the allocation sheet does not have one.
        </p>
        <div className="mt-3">
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
        </div>
      </details>

      <Card>
        <CardHeader
          title={`Teams (${teams.length})`}
          description="Teams sign in at the one common submission URL with their group number and access code."
          actions={
            demo ? (
              <DownloadButton
                label="Download demo invite CSV"
                filename={`invites-${cohort.code}.csv`}
                action={exportInvitesAction}
                arg={cohort.id}
              />
            ) : null
          }
        />

        {teams.length === 0 ? (
          <p className="text-sm text-muted">No teams imported yet.</p>
        ) : (
          <Table caption="Teams and their access status">
            <thead>
              <tr>
                <Th>Group</Th>
                <Th>Learners</Th>
                <Th>Access code</Th>
                {demo && <Th>Demo link</Th>}
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const token = demo?.getDemoInviteToken(team.id) ?? null;
                const revoked = team.invite?.revokedAt;
                return (
                  <tr key={team.id}>
                    <Td className="font-mono font-semibold">{team.groupNumber}</Td>
                    <Td>
                      {team.leadName && (
                        <p>
                          {team.leadName}
                          <span className="ml-1 text-xs text-muted">(lead)</span>
                        </p>
                      )}
                      <p>
                        {team.members.length} member{team.members.length === 1 ? '' : 's'}
                      </p>
                      {team.members.length > 0 && (
                        <p className="text-xs text-muted">
                          {team.members
                            .slice(0, 3)
                            .map((m) => m.fullName)
                            .join(', ')}
                          {team.members.length > 3 ? '…' : ''}
                        </p>
                      )}
                    </Td>
                    <Td>
                      <AccessCodeCell
                        status={codeByTeam.get(team.id)}
                        timezone={cohort.timezone}
                      />
                    </Td>
                    {demo && (
                      <Td>
                        {token ? (
                          <a
                            href={`${env.APP_BASE_URL}/submit/${token}`}
                            className="text-xs text-brand-text underline"
                          >
                            Open as this team
                          </a>
                        ) : (
                          <Badge tone="neutral">none</Badge>
                        )}
                      </Td>
                    )}
                    <Td>
                      <div className="flex flex-col gap-2">
                        {demo && !revoked && (
                          <AdminForm
                            action={revokeInviteAction}
                            csrfToken={session.csrfToken}
                            submitLabel="Revoke demo link"
                            submitVariant="ghost"
                            confirm={`Revoke the demo link for group ${team.groupNumber}?`}
                          >
                            <input type="hidden" name="teamId" value={team.id} />
                            <input type="hidden" name="cohortId" value={cohort.id} />
                          </AdminForm>
                        )}
                        <IssueCodesButton
                          action={regenerateOneCodeAction}
                          cohortId={cohort.id}
                          csrfToken={session.csrfToken}
                          teamId={team.id}
                          variant="secondary"
                          label="New code"
                          confirm={`Issue a new access code for group ${team.groupNumber}?\n\nTheir current code stops working immediately and anyone editing under it is signed out. Their saved work is untouched.\n\nThe new code downloads as a one-row file — it cannot be looked up later.`}
                        />
                        {codeByTeam.get(team.id)?.hasCode && (
                          <AdminForm
                            action={revokeAccessCodeAction}
                            csrfToken={session.csrfToken}
                            submitLabel="Revoke code"
                            submitVariant="ghost"
                            confirm={`Revoke the access code for group ${team.groupNumber}? Anyone editing under it is signed out immediately, and they cannot get back in until you issue a new one.`}
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
        Access codes are shared across a team by design: any member holding one can edit the
        submission. Treat the code sheet as sensitive, and distribute it through your own channel —
        this platform sends no email (ADR-024). There is no second way in: per-team invite links are
        demo-only and return 404 in production.
      </Alert>
    </div>
  );
}

// --------------------------------------------------------------------------

/**
 * Access codes: issue, replace, unlock.
 *
 * Sequenced the way an operator actually works. Import the allocation sheet and
 * issue codes for the teams it created; import a corrected sheet later and
 * issue codes for the teams that are new, without disturbing the rest. Then
 * spend hackathon day on the two things that really happen: a team that lost
 * its code, and a team that mistyped it enough times to lock itself out.
 *
 * Every button that issues a code also downloads the sheet, because generation
 * is the only moment the plaintext exists.
 */
function AccessCodeSection({
  cohort,
  codes,
  withoutCode,
  lockedOut,
  csrfToken,
  submitUrl,
}: {
  cohort: { id: string; code: string; timezone: string };
  codes: { groupNumber: number; hasCode: boolean; activeSessions: number }[];
  withoutCode: number;
  lockedOut: { groupNumber: number; lockedUntil: Date | null }[];
  csrfToken: string;
  submitUrl: string;
}) {
  const live = codes.filter((row) => row.hasCode).length;
  const editing = codes.reduce((total, row) => total + row.activeSessions, 0);

  return (
    <Card testId="access-codes">
      <CardHeader
        title="Team access codes"
        description="One code per team, shared by its members. The plaintext exists only while the sheet is being produced — it is never stored and cannot be looked up afterwards, so each button here issues codes and downloads the sheet in one step."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Teams with a live code" value={`${live} of ${codes.length}`} />
        <Stat label="Waiting for a code" value={String(withoutCode)} />
        <Stat label="Editing right now" value={String(editing)} />
      </div>

      {withoutCode > 0 && (
        <Alert tone="warning" className="mt-5">
          {withoutCode} team{withoutCode === 1 ? '' : 's'} cannot sign in yet. Issue their codes
          below.
        </Alert>
      )}

      <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-bold">Issue codes for teams that have none</h3>
          <p className="mt-1 text-sm text-muted">
            The normal step after importing the allocation sheet, and again after importing a
            corrected one. Teams already holding a working code are left alone.
          </p>
          <div className="mt-3">
            <IssueCodesButton
              action={issueMissingCodesAction}
              cohortId={cohort.id}
              csrfToken={csrfToken}
              label={
                withoutCode > 0
                  ? `Issue ${withoutCode} code${withoutCode === 1 ? '' : 's'} and download`
                  : 'Issue missing codes and download'
              }
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-bold">Replace every code</h3>
          <p className="mt-1 text-sm text-muted">
            For a sheet that leaked. Every team gets a new code, every sheet already distributed
            stops working, and everyone currently editing is signed out — their saved work is
            untouched, but they must sign in again with the new code.
          </p>
          <div className="mt-3">
            <IssueCodesButton
              action={rotateAllCodesAction}
              cohortId={cohort.id}
              csrfToken={csrfToken}
              variant="danger"
              label={`Replace all ${codes.length} codes and download`}
              confirm={`Replace the access code for all ${codes.length} teams?\n\nEvery code you have already sent out stops working immediately, and ${editing} team(s) currently editing will be signed out.\n\nOnly do this if a sheet has leaked.`}
            />
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-bold">Clear a lockout</h3>
          <p className="mt-1 text-sm text-muted">
            After eight wrong attempts a team waits fifteen minutes. On deadline evening that is
            fifteen minutes they do not have.
          </p>
          {lockedOut.length > 0 && (
            <p className="mt-2 text-sm text-warning" data-testid="locked-out">
              Locked out now:{' '}
              {lockedOut
                .map(
                  (row) =>
                    `group ${row.groupNumber} until ${
                      row.lockedUntil
                        ? formatInTimezone(row.lockedUntil, cohort.timezone, {
                            timeStyle: 'short',
                          })
                        : 'shortly'
                    }`,
                )
                .join(', ')}
            </p>
          )}
          <AdminForm
            action={clearLockoutAction}
            csrfToken={csrfToken}
            submitLabel="Clear lockout"
            submitVariant="secondary"
            className="mt-3"
          >
            <input type="hidden" name="cohortId" value={cohort.id} />
            <Field id="lockoutGroup" label="Group number">
              {(aria) => (
                <Input
                  {...aria}
                  name="groupNumber"
                  type="text"
                  inputMode="numeric"
                  className="max-w-[8rem]"
                />
              )}
            </Field>
          </AdminForm>
        </div>
      </div>

      <p className="mt-5 border-t border-line pt-4 text-sm text-muted">
        Teams sign in at <span className="font-mono text-ink">{submitUrl}</span>. Put that link in
        Circle yourself — the platform has no Circle integration and never posts anything.
      </p>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-line bg-surface-alt p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

/** One team's code state. Never the code itself — it does not exist to show. */
function AccessCodeCell({
  status,
  timezone,
}: {
  status?: {
    hasCode: boolean;
    version: number;
    revokedAt: Date | null;
    lastVerifiedAt: Date | null;
    activeSessions: number;
    lockedUntil: Date | null;
  };
  timezone: string;
}) {
  if (!status || (!status.hasCode && !status.revokedAt)) {
    return <Badge tone="neutral">none</Badge>;
  }
  if (status.revokedAt) return <Badge tone="danger">revoked</Badge>;

  const locked = status.lockedUntil && status.lockedUntil > new Date();

  return (
    <div>
      <Badge tone={locked ? 'warning' : 'success'}>{locked ? 'locked out' : 'live'}</Badge>
      <p className="mt-1 text-xs text-muted">
        {status.version > 1 && `v${status.version} · `}
        {status.activeSessions > 0
          ? `${status.activeSessions} editing`
          : status.lastVerifiedAt
            ? `last used ${formatInTimezone(status.lastVerifiedAt, timezone, { timeStyle: 'short' })}`
            : 'not used yet'}
      </p>
    </div>
  );
}
