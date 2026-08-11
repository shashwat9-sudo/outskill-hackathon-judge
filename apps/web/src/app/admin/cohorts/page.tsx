import Link from 'next/link';
import { COHORT_STATUSES, formatInTimezone } from '@ohj/shared';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { createCohortAction, setCohortStatusAction, startJudgingAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import { Badge, Card, CardHeader, Field, Input, Select, Table, Td, Textarea, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CohortsPage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Cohorts</h1>

      <Card>
        <CardHeader
          title="All cohorts"
          description="A cohort freezes its own ideas, rubric version and assessment configuration, so past judging stays reproducible."
        />
        {cohorts.length === 0 ? (
          <p className="text-sm text-muted">No cohorts yet. Create one below.</p>
        ) : (
          <Table caption="Cohorts">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Code</Th>
                <Th>Deadline</Th>
                <Th>Status</Th>
                <Th>Manage</Th>
              </tr>
            </thead>
            <tbody>
              {cohorts.map((cohort) => (
                <tr key={cohort.id}>
                  <Td className="font-medium">{cohort.name}</Td>
                  <Td className="font-mono">{cohort.code}</Td>
                  <Td>{formatInTimezone(cohort.day13DeadlineAt, cohort.timezone, { dateStyle: 'medium', timeStyle: 'short' })}</Td>
                  <Td>
                    <Badge tone={cohort.status === 'open' ? 'success' : 'neutral'}>{cohort.status}</Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/admin/cohorts/${cohort.id}/ideas`} className="text-brand underline">
                        Ideas
                      </Link>
                      <Link href={`/admin/cohorts/${cohort.id}/teams`} className="text-brand underline">
                        Teams
                      </Link>
                      <Link href={`/admin/cohorts/${cohort.id}/submissions`} className="text-brand underline">
                        Submissions
                      </Link>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {cohorts.map((cohort) => (
        <Card key={cohort.id}>
          <CardHeader
            title={`Run ${cohort.name}`}
            description="Open accepts submissions. Pause holds them. Close stops intake so judging can start."
            level={3}
          />
          <div className="grid gap-5 md:grid-cols-2">
            <AdminForm action={setCohortStatusAction} csrfToken={session.csrfToken} submitLabel="Change status">
              <input type="hidden" name="cohortId" value={cohort.id} />
              <Field id={`status-${cohort.id}`} label="Status">
                {(aria) => (
                  <Select {...aria} name="status" defaultValue={cohort.status}>
                    {COHORT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </AdminForm>

            <AdminForm
              action={startJudgingAction}
              csrfToken={session.csrfToken}
              submitLabel="Start judging"
              confirm="Queue every finally-submitted entry in this cohort for assessment?"
            >
              <input type="hidden" name="cohortId" value={cohort.id} />
              <p className="text-sm text-muted">
                Queues every finally-submitted entry. Drafts are skipped. Safe to run more than once —
                already-queued submissions are not duplicated.
              </p>
            </AdminForm>
          </div>
        </Card>
      ))}

      <Card>
        <CardHeader
          title="Create a cohort"
          description="Approved ideas are copied from your most recent cohort, so a new cohort is usable immediately."
        />
        <AdminForm action={createCohortAction} csrfToken={session.csrfToken} submitLabel="Create cohort">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="name" label="Name" required>
              {(aria) => <Input {...aria} name="name" placeholder="AI Accelerator — Cohort 7" />}
            </Field>
            <Field id="code" label="Code" required hint="Short, uppercase. Appears in receipt IDs.">
              {(aria) => <Input {...aria} name="code" placeholder="AIAP7" />}
            </Field>
            <Field id="day12StartAt" label="Day 12 start" required>
              {(aria) => <Input {...aria} name="day12StartAt" type="datetime-local" />}
            </Field>
            <Field
              id="day13DeadlineAt"
              label="Day 13 deadline"
              required
              hint="11:59 PM in the cohort timezone."
            >
              {(aria) => <Input {...aria} name="day13DeadlineAt" type="datetime-local" />}
            </Field>
            <Field id="timezone" label="Timezone">
              {(aria) => <Input {...aria} name="timezone" defaultValue="Asia/Kolkata" />}
            </Field>
            <Field id="shortlistTarget" label="Internal shortlist target">
              {(aria) => <Input {...aria} name="shortlistTarget" type="number" min={1} max={100} defaultValue={10} />}
            </Field>
          </div>
          <div className="mt-5 space-y-5">
            <Field id="description" label="Description">
              {(aria) => <Textarea {...aria} name="description" rows={2} />}
            </Field>
            <Field
              id="submissionInstructions"
              label="Submission instructions"
              hint="Shown to participants on their submission page."
            >
              {(aria) => <Textarea {...aria} name="submissionInstructions" rows={3} />}
            </Field>
          </div>
        </AdminForm>
      </Card>
    </div>
  );
}
