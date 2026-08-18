'use client';

import * as React from 'react';
import { Alert, Button, Field, Input, Textarea, cn } from '@/components/ui';
import { createCohortAction } from '@/server/admin-actions';

/**
 * Guided cohort creation.
 *
 * Three steps in a drawer rather than a permanent form under the cohort list.
 * The review step exists so an operator sees what will be inherited — ideas and
 * rubric version are copied forward, and that is worth knowing before pressing
 * create rather than discovering afterwards.
 */

const STEPS = ['Basics', 'Schedule', 'Review'] as const;

export function CreateCohortFlow({ csrfToken }: { csrfToken: string }) {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [values, setValues] = React.useState({
    name: '',
    code: '',
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: '',
    day13DeadlineAt: '',
    shortlistTarget: '10',
    submissionInstructions: '',
  });

  const set = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const basicsValid = values.name.trim().length > 0 && values.code.trim().length > 0;
  const scheduleValid = values.day12StartAt !== '' && values.day13DeadlineAt !== '';

  const submit = async () => {
    setPending(true);
    setError(null);

    const formData = new FormData();
    formData.set('csrf', csrfToken);
    Object.entries(values).forEach(([key, value]) => formData.set(key, value));

    try {
      const result = await createCohortAction(formData);
      if (result.ok) {
        setOpen(false);
        window.location.reload();
      } else {
        setError(result.error ?? 'Could not create the cohort.');
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ Create cohort</Button>;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70" role="dialog" aria-modal="true" aria-label="Create a cohort">
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-ink">Create a cohort</h2>
            <p className="mt-1 text-sm text-muted">Three steps. Nothing is saved until the end.</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-[10px] border border-line px-3 py-1.5 text-sm font-semibold text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>

        {/* Step indicator */}
        <ol className="mt-6 flex gap-2">
          {STEPS.map((label, index) => (
            <li key={label} className="flex-1">
              <div
                className={cn(
                  'rounded-[10px] border px-3 py-2 text-sm font-medium',
                  index === step
                    ? 'border-brand-edge bg-brand-tint text-ink'
                    : index < step
                      ? 'border-line bg-canvas text-muted'
                      : 'border-line bg-canvas text-muted',
                )}
              >
                <span aria-hidden="true" className={cn('mr-2', index < step && 'text-brand-text')}>
                  {index < step ? '✓' : index + 1}
                </span>
                {label}
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-6 space-y-5">
          {step === 0 && (
            <>
              <Field id="cohort-name" label="Name" required>
                {(aria) => (
                  <Input
                    {...aria}
                    value={values.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="AI Accelerator — Cohort 7"
                  />
                )}
              </Field>
              <Field
                id="cohort-code"
                label="Code"
                required
                hint="Short and uppercase. Appears in every receipt ID."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={values.code}
                    onChange={(e) => set('code', e.target.value.toUpperCase())}
                    placeholder="AIAP7"
                  />
                )}
              </Field>
              <Field id="cohort-description" label="Description">
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={values.description}
                    onChange={(e) => set('description', e.target.value)}
                  />
                )}
              </Field>
              <Field id="cohort-timezone" label="Timezone" hint="Deadlines are evaluated in this zone.">
                {(aria) => (
                  <Input
                    {...aria}
                    value={values.timezone}
                    onChange={(e) => set('timezone', e.target.value)}
                  />
                )}
              </Field>
            </>
          )}

          {step === 1 && (
            <>
              <Field id="cohort-start" label="Day 12 start" required>
                {(aria) => (
                  <Input
                    {...aria}
                    type="datetime-local"
                    value={values.day12StartAt}
                    onChange={(e) => set('day12StartAt', e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="cohort-deadline"
                label="Day 13 deadline"
                required
                hint="11:59 PM in the cohort timezone."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    type="datetime-local"
                    value={values.day13DeadlineAt}
                    onChange={(e) => set('day13DeadlineAt', e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="cohort-shortlist"
                label="Shortlist target"
                hint="How many submissions are privately highlighted."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    type="number"
                    min={1}
                    max={100}
                    value={values.shortlistTarget}
                    onChange={(e) => set('shortlistTarget', e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="cohort-instructions"
                label="Submission instructions"
                hint="Shown on every participant's submission page."
              >
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={3}
                    value={values.submissionInstructions}
                    onChange={(e) => set('submissionInstructions', e.target.value)}
                  />
                )}
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <dl className="space-y-3 rounded-[10px] border border-line bg-canvas p-4">
                {[
                  ['Name', values.name || '—'],
                  ['Code', values.code || '—'],
                  ['Timezone', values.timezone],
                  ['Day 12 start', values.day12StartAt || '—'],
                  ['Day 13 deadline', values.day13DeadlineAt || '—'],
                  ['Shortlist target', values.shortlistTarget],
                ].map(([term, value]) => (
                  <div key={term} className="flex justify-between gap-4 text-sm">
                    <dt className="text-muted">{term}</dt>
                    <dd className="font-semibold text-ink">{value}</dd>
                  </div>
                ))}
              </dl>

              <Alert tone="info" title="What this cohort inherits">
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  <li>Approved ideas are copied from your most recent cohort, and stay editable.</li>
                  <li>Rubric version rubric-v1, frozen to this cohort.</li>
                  <li>
                    The cohort starts in <strong>draft</strong> — participants cannot reach it until
                    you open submissions.
                  </li>
                </ul>
              </Alert>

              {error && <Alert tone="danger">{error}</Alert>}
            </>
          )}
        </div>

        <div className="mt-8 flex justify-between gap-3 border-t border-line pt-5">
          <Button
            variant="ghost"
            onClick={() => (step === 0 ? setOpen(false) : setStep((s) => s - 1))}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>

          {step < STEPS.length - 1 ? (
            <Button
              disabled={step === 0 ? !basicsValid : !scheduleValid}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue
            </Button>
          ) : (
            <Button loading={pending} onClick={submit}>
              Create cohort
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
