import { getEnvConfig, getStore, isDemo } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { rotateCredentialsAction, updateSettingAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import { Alert, Card, CardHeader, Field, Input, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireAdmin();
  const store = getStore();
  const env = getEnvConfig();
  const settings = await store.settings.getAll();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader
          title="Shared admin credentials"
          description="One account for the whole team. Rotate it whenever someone leaves — that is the only control that removes their access."
        />

        <Alert tone="warning" className="mb-4">
          A shared account cannot attribute an action to a person. The audit log records{' '}
          <code className="font-mono">shared-admin</code> and proves <em>what</em> happened and{' '}
          <em>when</em>, never <em>who</em>.
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

      <Card>
        <CardHeader
          title="Operational settings"
          description="Tunable at runtime. Secrets never live here — they come from the environment."
        />
        <div className="space-y-4">
          {settings.map((setting) => (
            <div key={setting.key} className="rounded-md border border-line p-4">
              <p className="font-mono text-sm font-semibold">{setting.key}</p>
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
      </Card>

      <Card>
        <CardHeader
          title="Runtime configuration"
          description="Read-only. Set through the environment, validated at startup — the process refuses to boot on invalid config."
        />
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
              ['Credential encryption key', env.CREDENTIAL_ENCRYPTION_KEY ? 'configured' : 'not configured (demo key in use)'],
              ['Worker concurrency', String(env.WORKER_CONCURRENCY)],
              ['Browser budget per submission', `${env.BROWSER_TEST_BUDGET_MS / 1000}s`],
              ['Job lease', `${env.JOB_LEASE_SECONDS}s`],
              ['Evidence retention', `${env.RETENTION_EVIDENCE_DAYS} days`],
              ['Submission retention', `${env.RETENTION_SUBMISSION_DAYS} days`],
              [
                'Automatic deletion',
                env.NODE_ENV === 'production' && !env.DEMO_MODE
                  ? 'enabled'
                  : 'disabled outside production and in demo mode',
              ],
            ].map(([label, value]) => (
              <tr key={label}>
                <Th scope="row">{label}</Th>
                <Td className="font-mono">{value}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
