'use client';

import * as React from 'react';
import { ACCESS_CODE_LENGTH } from '@ohj/shared/client';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { startEditingAction, verifyTeamAction } from '@/server/participant-actions';

/**
 * Team entry.
 *
 * Two steps behind one URL, because they answer two different questions:
 *
 *   1. Which team is this? — group number and shared access code.
 *   2. Who is editing right now? — a name, for the team's own activity log.
 *
 * The access code is typed once and posted once. It is never put in the URL,
 * never written to storage, and never echoed back — the server carries the
 * verified team forward in an HttpOnly cookie, so nothing sensitive survives in
 * this component after step one.
 */

type Stage = 'verify' | 'identify';

export function TeamEntry({ demoHint }: { demoHint?: string }) {
  const [stage, setStage] = React.useState<Stage>('verify');
  const [error, setError] = React.useState<string | null>(null);
  const [retryAfter, setRetryAfter] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onVerify(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await verifyTeamAction(formData);
    setBusy(false);

    if (result.ok) {
      setRetryAfter(null);
      setStage('identify');
      return;
    }
    setError(result.error ?? 'We could not verify those details.');
    setRetryAfter(result.retryAfterSeconds ?? null);
  }

  async function onIdentify(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await startEditingAction(formData);
    setBusy(false);

    if (result.ok) {
      // A full navigation, not a router push: the session cookie was just set,
      // and the portal must be rendered by a request that carries it.
      window.location.href = '/submit/portal';
      return;
    }
    setError(result.error ?? 'Could not start editing.');
  }

  return (
    <Card tone="raised" className="mt-8">
      {stage === 'verify' ? (
        <form action={onVerify} data-testid="team-verify-form" className="space-y-5">
          <div>
            <h2 className="text-xl font-bold text-ink">Find your team</h2>
            <p className="mt-1.5 text-sm text-muted">
              Use the group number and team access code Outskill gave you. Any member of your team
              can use them.
            </p>
          </div>

          <Field
            id="groupNumber"
            label="Group number"
            hint="The number your team was given at the start of the accelerator."
            required
          >
            {(aria) => (
              <Input
              name="groupNumber"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={3}
              className="max-w-[8rem]"
              required
              {...aria}
              />
            )}
          </Field>

          <Field
            id="accessCode"
            label="Team access code"
            hint={`${ACCESS_CODE_LENGTH} characters. Upper or lower case, with or without the dashes.`}
            required
          >
            {(aria) => (
              <Input
              name="accessCode"
              type="text"
              // Not type="password": a shared team code is read aloud across a
              // room, and hiding it causes far more mistyping than it prevents
              // shoulder-surfing.
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCD-EFGH-JKMN"
              className="max-w-[20rem] font-mono tracking-[0.14em]"
              required
              {...aria}
              />
            )}
          </Field>

          {error && (
            <Alert tone="danger" testId="verify-error">
              {error}
              {retryAfter !== null && retryAfter > 0 && (
                <>
                  {' '}
                  Too many attempts — wait about {Math.max(1, Math.ceil(retryAfter / 60))} minute
                  {Math.ceil(retryAfter / 60) === 1 ? '' : 's'} and try again, or ask the Outskill
                  team to reset it.
                </>
              )}
            </Alert>
          )}

          <Button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>

          {demoHint && (
            <p className="border-t border-line pt-4 text-xs text-muted" data-testid="demo-hint">
              {demoHint}
            </p>
          )}
        </form>
      ) : (
        <form action={onIdentify} data-testid="editor-name-form" className="space-y-5">
          <div>
            <h2 className="text-xl font-bold text-ink">Who is editing?</h2>
            <p className="mt-1.5 text-sm text-muted">
              Your team shares one submission. Adding your name means everyone can see who changed
              what — it is not a login, and it does not restrict anyone.
            </p>
          </div>

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

          <Field id="editorRole" label="What you work on" hint="Optional. For example: backend, design, demo video.">
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
            <Alert tone="danger" testId="identify-error">
              {error}
            </Alert>
          )}

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Opening…' : 'Open our submission'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStage('verify');
                setError(null);
              }}
            >
              Use a different team
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
