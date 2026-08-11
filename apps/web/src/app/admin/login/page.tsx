import { redirect } from 'next/navigation';
import { ensureAdminAccount, getAdminSession } from '@/server/admin-auth';
import { isDemo } from '@/lib/store';
import { Alert, Card } from '@/components/ui';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
  // Seeds the single shared account on first run. There is no signup.
  await ensureAdminAccount();
  if (await getAdminSession()) redirect('/admin');

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand">Outskill</p>
        <h1 className="mt-1 text-2xl font-bold">Hackathon Judge — internal sign in</h1>
        <p className="mt-2 text-sm text-muted">
          One shared account for the Outskill team. Actions are logged as{' '}
          <code className="font-mono">shared-admin</code> and cannot be attributed to an individual.
        </p>

        <Card className="mt-6">
          <LoginForm />
        </Card>

        {isDemo() && (
          <Alert tone="info" className="mt-4">
            Demo mode — sign in with <code className="font-mono">outskill-admin</code> /{' '}
            <code className="font-mono">demo-admin-password</code>. Change these before any real use.
          </Alert>
        )}
      </div>
    </div>
  );
}
