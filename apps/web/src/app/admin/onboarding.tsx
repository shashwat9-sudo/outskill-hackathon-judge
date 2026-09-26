'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, cn } from '@/components/ui';

/**
 * First-run onboarding for Outskill operators.
 *
 * Shown once in demo mode and dismissed locally. Dismissal is remembered in
 * `localStorage`, so it never nags — an operator who has seen it should not
 * have to close it again on every visit.
 */

const STORAGE_KEY = 'ohj.onboarding.dismissed.v1';

const STEPS = [
  'Configure the cohort',
  'Review product ideas',
  'Import learners and issue access codes',
  'Open submissions',
  'Start automated judging',
  'Review the top 10 and select the winners',
];

export function OnboardingPanel({
  cohortId,
  previewHref,
}: {
  cohortId: string | null;
  previewHref: string | null;
}) {
  // Starts hidden and appears after mount, so the server render never shows a
  // panel the operator already dismissed.
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== '1') setVisible(true);
    } catch {
      // Private browsing or blocked storage — show it, but do not crash.
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Dismissal simply will not persist. Not worth surfacing.
    }
  };

  if (!visible) return null;

  return (
    <Card tone="accent" className="mb-8" testId="onboarding-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">Welcome to Hackathon Judge</h2>
          <p className="mt-1.5 text-sm text-muted">Run your cohort in six steps.</p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-[10px] border border-line px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:text-ink"
        >
          Dismiss
        </button>
      </div>

      <ol className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-start gap-2.5 text-sm text-ink">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-brand-edge text-xs font-bold text-brand-text"
            >
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={cohortId ? `/admin/cohorts/${cohortId}/ideas` : '/admin/cohorts'}
          className="rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-brand-hover"
        >
          Start setup
        </Link>
        <Link
          href={previewHref ?? '/'}
          className={cn(
            'rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge',
          )}
        >
          Preview learner journey
        </Link>
        <a
          href="/api/admin/resources/ADMIN_PLAYBOOK"
          className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
        >
          Open admin playbook
        </a>
      </div>
    </Card>
  );
}
