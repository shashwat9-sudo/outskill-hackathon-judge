'use client';

import * as React from 'react';
import {
  COMMON_MISTAKES,
  FIELD_GUIDANCE,
  STEP_GUIDANCE,
  SUBMISSION_CHECKLIST,
  requirementLine,
} from '@ohj/shared/client';
import { cn } from '@/components/ui';
import { useLearnerGuidance } from './walkthrough';

/**
 * One help menu, five things in it.
 *
 * The temptation with a form this size is a help centre, and a help centre is
 * where questions go to not get answered — a learner mid-form will not read a
 * knowledge base, they will message someone at Outskill. So: five entries, each
 * one either a short panel that opens in place or a page that opens in a new
 * tab, and nothing that loses the answers they have typed.
 *
 * Reads guidance and calls nothing. No save path, no submission state; the only
 * thing it can change is which panel is open.
 */

type PanelKey = 'step' | 'checklist' | 'resources' | null;

export interface HelpResource {
  id: string;
  title: string;
  description: string;
}

export function HelpMenu({ resources }: { resources: HelpResource[] }) {
  const { openTour, step } = useLearnerGuidance();
  const [open, setOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<PanelKey>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    setPanel(null);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <>
      {/*
        Reachable at every scroll position, and aligned with the content rather
        than with the window.

        Two things were wrong when this was pinned to the viewport edge. It sat
        on top of the action bar between 640px and 1024px, where that bar is
        still fixed — so "Need help?" covered "Save and continue". And on a
        1920px screen it floated nearly 300px clear of the column it belongs to,
        which reads as a stray browser control rather than part of the page.

        The rail is inert; only the pill takes clicks, so it never swallows a
        press meant for the form underneath.
      */}
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-30 mx-auto flex max-w-6xl justify-end px-4 sm:px-6',
          // Clear of the action bar until that bar rejoins the page flow at lg.
          'bottom-[5.5rem] lg:bottom-6',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="need-help"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'pointer-events-auto flex min-h-11 items-center gap-2 rounded-full border border-line',
            'bg-surface px-4 py-2.5 text-sm font-semibold text-ink shadow-lg',
            'hover:border-brand-edge',
          )}
        >
          <span aria-hidden="true">?</span>
          Need help?
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-menu-title"
          data-testid="help-menu"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className={cn(
              'flex max-h-[85vh] w-full max-w-md flex-col bg-surface shadow-xl',
              'rounded-t-[18px] border-t border-line sm:rounded-[18px] sm:border',
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <h2 id="help-menu-title" className="text-base font-bold text-ink">
                Need help?
              </h2>
              <button
                type="button"
                onClick={close}
                data-testid="close-help"
                className="min-h-11 px-2 text-sm font-semibold text-muted underline underline-offset-4 hover:text-ink"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              <HelpRow
                label="How to fill this step"
                expanded={panel === 'step'}
                onClick={() => setPanel(panel === 'step' ? null : 'step')}
              >
                <StepHelp step={step} />
              </HelpRow>

              <HelpLink
                label="See a completed example"
                href="/submit/example"
                testId="help-example"
              />

              <HelpRow
                label="Replay submission tour"
                testId="help-replay-tour"
                onClick={() => {
                  close();
                  openTour();
                }}
              />

              <HelpRow
                label="Submission checklist"
                expanded={panel === 'checklist'}
                onClick={() => setPanel(panel === 'checklist' ? null : 'checklist')}
              >
                <Checklist />
              </HelpRow>

              <HelpRow
                label="Resources"
                expanded={panel === 'resources'}
                onClick={() => setPanel(panel === 'resources' ? null : 'resources')}
              >
                <Resources resources={resources} />
              </HelpRow>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------

function HelpRow({
  label,
  onClick,
  expanded,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={children ? Boolean(expanded) : undefined}
        data-testid={testId}
        data-help-row=""
        className="flex w-full min-h-11 items-center justify-between gap-3 rounded-[10px] px-3 py-3 text-left text-sm font-semibold text-ink hover:bg-surface-alt"
      >
        <span>{label}</span>
        <span aria-hidden="true" className={cn('text-muted transition-transform', expanded && 'rotate-90')}>
          ›
        </span>
      </button>
      {children && expanded && <div className="px-3 pb-4 pt-1">{children}</div>}
    </div>
  );
}

function HelpLink({ label, href, testId }: { label: string; href: string; testId?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      data-help-row=""
      className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-3 py-3 text-sm font-semibold text-ink hover:bg-surface-alt"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="text-muted">
        ↗
      </span>
    </a>
  );
}

/**
 * What this step is asking for.
 *
 * The step's own sentence, what to have ready, and every question in it with
 * its rule. It is the same content the step itself shows — read from the same
 * place — so nobody can be told two different things about one question.
 */
function StepHelp({ step }: { step: keyof typeof STEP_GUIDANCE }) {
  const guide = STEP_GUIDANCE[step];
  const questions = Object.entries(FIELD_GUIDANCE).filter(([path]) =>
    step === 'review' ? false : path.startsWith(`${step}.`),
  );

  return (
    <div data-testid="help-step-panel">
      <p className="text-sm text-muted">{guide.intro}</p>

      {guide.prepare && guide.prepare.length > 0 && (
        <>
          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-brand-text">
            Have this ready
          </p>
          <ul className="mt-2 space-y-1.5">
            {guide.prepare.map((item) => (
              <li key={item} className="flex gap-2 text-sm text-muted">
                <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand" />
                {item}
              </li>
            ))}
          </ul>
        </>
      )}

      {questions.length > 0 && (
        <>
          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-brand-text">
            What we ask on this step
          </p>
          <ul className="mt-2 space-y-2.5">
            {questions.map(([path, field]) => {
              const rule = requirementLine(field);
              return (
                <li key={path}>
                  <p className="text-sm font-medium text-ink">{field.label}</p>
                  {rule && rule !== 'Optional.' && <p className="text-xs text-muted">{rule}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {step === 'review' && (
        <p className="mt-3 text-sm text-muted">
          Check each section, tick the declarations, then use Final Submit. Final Submit locks your
          submission.
        </p>
      )}
    </div>
  );
}

function Checklist() {
  return (
    <div data-testid="help-checklist">
      <p className="text-sm text-muted">What to have ready before you start.</p>
      <div className="mt-3 space-y-3">
        {SUBMISSION_CHECKLIST.map(({ step, items }) => (
          <div key={step}>
            <p className="text-xs font-bold uppercase tracking-wider text-brand-text">
              {STEP_GUIDANCE[step].label}
            </p>
            <ul className="mt-1.5 space-y-1">
              {items.map((item) => (
                <li key={item} className="flex gap-2 text-sm text-muted">
                  <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs font-bold uppercase tracking-wider text-brand-text">
        Mistakes that cost teams marks
      </p>
      <ul className="mt-2 space-y-1.5">
        {COMMON_MISTAKES.map((mistake) => (
          <li key={mistake} className="flex gap-2 text-sm text-muted">
            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-warning" />
            {mistake}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Resources({ resources }: { resources: HelpResource[] }) {
  return (
    <ul className="space-y-3" data-testid="help-resources">
      <li>
        <a
          href="/submit/guide"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-brand-text underline underline-offset-4"
        >
          Hackathon Submission Guide
        </a>
        <p className="text-xs text-muted">The six steps, with examples. Also downloadable as a PDF.</p>
      </li>
      <li>
        <a
          href="/api/resources/pitch-template"
          className="text-sm font-semibold text-brand-text underline underline-offset-4"
        >
          Pitch-deck template
        </a>
      </li>
      {resources.map((resource) => (
        <li key={resource.id}>
          <a
            href={`/api/resources/${resource.id}`}
            className="text-sm font-semibold text-brand-text underline underline-offset-4"
          >
            {resource.title}
          </a>
          <p className="text-xs text-muted">{resource.description}</p>
        </li>
      ))}
    </ul>
  );
}
