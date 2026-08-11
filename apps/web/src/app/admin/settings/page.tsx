import { getEnvConfig, getStore, isDemo } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  rotateCredentialsAction,
  updateJudgingSettingsAction,
  updateSettingAction,
} from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import {
  Alert,
  Card,
  CardHeader,
  Disclosure,
  Field,
  Input,
  PageHeading,
  Table,
  Td,
  Th,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Settings.
 *
 * Five clearly separated areas. Judging configuration is expressed in the units
 * an operator thinks in — minutes, counts — and converted to milliseconds on
 * the way in. Raw keys stay available under Advanced, where a developer can
 * find them without a programme operator having to read them.
 */
export default async function SettingsPage() {
  const session = await requireAdmin();
  const store = getStore();
  const env = getEnvConfig();
  const settings = await store.settings.getAll();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0];

  const config = cohort?.assessmentConfig;
  const browserMinutes = config ? Math.round(config.browserBudgetMs / 60_000) : 8;

  return (
    <div>
      <PageHeading
        title="Settings"
        description="Access, judging configuration, retention and system diagnostics."
      />

      {/* 1 — Admin access */}
      <Card className="mb-6">
        <CardHeader
          title="Admin access"
          description="One shared account for the whole Outskill team. Rotate it whenever someone leaves — that is the only thing that removes their access."
        />

        <Alert tone="warning" className="mb-5">
          A shared account cannot attribute an action to a person. The audit log proves what happened
          and when, never who.
        </Alert>

        <AdminForm
          action={rotateCredentialsAction}
          csrfToken={session.csrfToken}
          submitLabel="Rotate credentials"
          confirm="Rotate the shared credentials? Changing the password signs everyone out, including you."
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <Field id="currentPassword" label="Current password" required>
              {(aria) => (
                <Input {...aria} name="currentPassword" type="password" autoComplete="current-password" />
              )}
            </Field>
            <Field id="newUsername" label="New username" hint="Leave blank to keep it.">
              {(aria) => <Input {...aria} name="newUsername" defaultValue={session.username} />}
            </Field>
            <Field
              id="newPassword"
              label="New password"
              hint="At least 12 characters. Leave blank to keep it."
            >
              {(aria) => <Input {...aria} name="newPassword" type="password" autoComplete="new-password" />}
            </Field>
          </div>
        </AdminForm>
      </Card>

      {/* 2 — Judging configuration, in human units */}
      <Card className="mb-6">
        <CardHeader
          title="Judging configuration"
          description="How thoroughly and how quickly submissions are assessed."
        />

        <Alert tone="warning" className="mb-5">
          Changing these mid-cohort means teams are not all judged under the same conditions. Prefer
          to change them between cohorts.
        </Alert>

        <AdminForm
          action={updateJudgingSettingsAction}
          csrfToken={session.csrfToken}
          submitLabel="Save judging settings"
          confirm="Save judging settings? Teams assessed before and after this change will have been judged under different conditions."
        >
          <input type="hidden" name="cohortId" value={cohort?.id ?? ''} />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              id="workerConcurrency"
              label="Concurrent assessments"
              hint="How many submissions are tested at once."
            >
              {(aria) => (
                <Input
                  {...aria}
                  name="workerConcurrency"
                  type="number"
                  min={1}
                  max={32}
                  defaultValue={config?.workerConcurrency ?? 4}
                />
              )}
            </Field>
            <Field
              id="browserMinutes"
              label="Maximum browser-testing time"
              hint="Minutes per submission. Longer means deeper evidence and a slower cohort."
            >
              {(aria) => (
                <Input
                  {...aria}
                  name="browserMinutes"
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={browserMinutes}
                />
              )}
            </Field>
            <Field id="maxAttempts" label="Maximum retries" hint="Before a submission is parked as failed.">
              {(aria) => (
                <Input
                  {...aria}
                  name="maxAttempts"
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={config?.maxAttempts ?? 3}
                />
              )}
            </Field>
            <Field
              id="lowConfidenceThreshold"
              label="Low-confidence threshold"
              hint="Between 0 and 1. Below this, a category is flagged for human review."
            >
              {(aria) => (
                <Input
                  {...aria}
                  name="lowConfidenceThreshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  defaultValue={config?.lowConfidenceThreshold ?? 0.6}
                />
              )}
            </Field>
            <Field
              id="shortlistTarget"
              label="Top shortlist size"
              hint="How many submissions are highlighted privately."
            >
              {(aria) => (
                <Input
                  {...aria}
                  name="shortlistTarget"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={cohort?.shortlistTarget ?? 10}
                />
              )}
            </Field>
          </div>
        </AdminForm>
      </Card>

      {/* 3 — Retention and privacy */}
      <Card className="mb-6">
        <CardHeader
          title="Retention and privacy"
          description="How long assessment material is kept, and what is destroyed when judging finishes."
        />
        <Table caption="Retention policy">
          <tbody>
            <tr>
              <Th scope="row">Demo credentials</Th>
              <Td>Destroyed when judging is finalised.</Td>
            </tr>
            <tr>
              <Th scope="row">Browser evidence and traces</Th>
              <Td>{env.RETENTION_EVIDENCE_DAYS} days</Td>
            </tr>
            <tr>
              <Th scope="row">Submissions and reports</Th>
              <Td>{env.RETENTION_SUBMISSION_DAYS} days</Td>
            </tr>
            <tr>
              <Th scope="row">Automatic deletion</Th>
              <Td>
                {env.NODE_ENV === 'production' && !env.DEMO_MODE
                  ? 'Enabled'
                  : 'Disabled outside production and in demo mode, so local work cannot be destroyed.'}
              </Td>
            </tr>
            <tr>
              <Th scope="row">Participant reports</Th>
              <Td>Generated and stored, exposed to nobody in this version.</Td>
            </tr>
          </tbody>
        </Table>
      </Card>

      {/* 4 — Advanced */}
      <Disclosure summary="Advanced system settings" testId="advanced-settings">
        <Alert tone="danger" className="mb-5">
          These are the raw stored values. Editing them directly bypasses the friendly controls above
          and can make a cohort internally inconsistent.
        </Alert>

        <div className="space-y-4">
          {settings.map((setting) => (
            <div key={setting.key} className="rounded-[10px] border border-line bg-canvas p-4">
              <p className="font-mono text-sm font-semibold text-ink">{setting.key}</p>
              {setting.description && <p className="mb-2 text-sm text-muted">{setting.description}</p>}
              <AdminForm
                action={updateSettingAction}
                csrfToken={session.csrfToken}
                submitLabel="Update"
                submitVariant="secondary"
              >
                <input type="hidden" name="key" value={setting.key} />
                <Field id={`setting-${setting.key}`} label="Value">
                  {(aria) => (
                    <Input
                      {...aria}
                      name="value"
                      defaultValue={
                        typeof setting.value === 'object'
                          ? JSON.stringify(setting.value)
                          : String(setting.value)
                      }
                    />
                  )}
                </Field>
              </AdminForm>
            </div>
          ))}
        </div>
      </Disclosure>

      {/* 5 — Diagnostics, including storage internals */}
      <div className="mt-4">
        <Disclosure summary="System diagnostics" testId="system-diagnostics">
          <Table caption="Runtime configuration">
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>Value</Th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Demo mode', isDemo() ? 'on — deterministic fixtures, no external services' : 'off'],
                ['Data driver', store.driver],
                ['AI provider', env.AI_PROVIDER],
                ['AI model', env.AI_MODEL || 'not set'],
                ['AI key', env.AI_API_KEY ? 'configured' : 'not configured'],
                ['Supabase', env.SUPABASE_URL ? 'configured' : 'not configured'],
                [
                  'Credential encryption key',
                  env.CREDENTIAL_ENCRYPTION_KEY ? 'configured' : 'not configured (demo key in use)',
                ],
                ['Job lease', `${env.JOB_LEASE_SECONDS}s`],
                ['Rubric version', cohort?.rubricVersion ?? '—'],
                ['Prompt version', config?.promptVersion ?? '—'],
                ['Model version pinned to cohort', config?.modelVersion ?? '—'],
              ].map(([label, value]) => (
                <tr key={label}>
                  <Th scope="row">{label}</Th>
                  <Td className="font-mono">{value}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <h3 className="mt-6 mb-2 text-sm font-bold text-ink">Storage diagnostics</h3>
          <p className="mb-3 text-sm text-muted">
            Every bucket is private. Access is only ever through a short-lived signed URL minted
            after an authorisation check.
          </p>
          <Table caption="Storage buckets">
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
                  <Td className={reachable === 'No' ? 'font-semibold text-ink' : undefined}>
                    {reachable}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Disclosure>
      </div>
    </div>
  );
}
