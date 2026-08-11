'use client';

import * as React from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { loginAction } from '@/server/admin-actions';

export function LoginForm() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    try {
      // On success the action redirects, so control does not return here.
      const result = await loginAction(formData);
      if (result && !result.ok) setError(result.error ?? 'Sign in failed.');
    } catch (thrown) {
      // Next signals a redirect by throwing; that is the success path.
      if (thrown && typeof thrown === 'object' && 'digest' in thrown) throw thrown;
      setError(thrown instanceof Error ? thrown.message : 'Sign in failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="username" label="Username" required>
        {(aria) => <Input {...aria} name="username" autoComplete="username" autoFocus />}
      </Field>
      <Field id="password" label="Password" required>
        {(aria) => (
          <Input {...aria} name="password" type="password" autoComplete="current-password" />
        )}
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" loading={pending} className="w-full" size="lg">
        Sign in
      </Button>
    </form>
  );
}
