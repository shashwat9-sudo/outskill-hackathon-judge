'use client';

import * as React from 'react';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { startEditingWithInviteAction } from '@/server/participant-actions';

/**
 * The editor-name step for the invite path.
 *
 * Identical in substance to the second step of the common flow: the name is an
 * activity label, not a login, and it does not restrict anyone.
 */
export function InviteEntry({ token }: { token: string }) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await startEditingWithInviteAction(formData);
    setBusy(false);

    if (result.ok) {
      // A full navigation: the session cookie was just set, and the portal must
      // be rendered by a request that carries it.
      window.location.href = '/submit/portal';
      return;
    }
    setError(result.error ?? 'Could not open the submission.');
  }

  return (
    <Card tone="raised" className="mt-8">
      <form action={onSubmit} data-testid="invite-entry-form" className="space-y-5">
        <input type="hidden" name="token" value={token} />

        <Field id="editorName" label="Your name" required>
          {(aria) => (
            <Input
            name="editorName"
            type="text"
            autoComplete="name"
            maxLength={80}
            className="max-w-[24rem]"
            required
            {...aria}
            />
          )}
        </Field>

        <Field
          id="editorRole"
          label="What you work on"
          hint="Optional. For example: backend, design, demo video."
        >
          {(aria) => (
            <Input
            name="editorRole"
            type="text"
            autoComplete="off"
            maxLength={80}
            className="max-w-[24rem]"
            {...aria}
            />
          )}
        </Field>

        {error && (
          <Alert tone="danger" testId="invite-error">
            {error}
          </Alert>
        )}

        <Button type="submit" disabled={busy}>
          {busy ? 'Opening…' : 'Open our submission'}
        </Button>
      </form>
    </Card>
  );
}
