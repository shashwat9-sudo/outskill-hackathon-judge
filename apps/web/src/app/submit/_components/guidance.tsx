'use client';

import * as React from 'react';
import {
  collectMissingItems,
  fieldDomId,
  fieldGuide,
  missingSummaryLabel,
  requirementLine,
  type MissingItem,
  type LearnerStepKey,
  type SubmissionCompleteness,
} from '@ohj/shared/client';
import { cn } from '@/components/ui';

/**
 * The guidance layer.
 *
 * Everything a learner reads while filling in the form — the question, the one
 * line under it, the rule, the worked example, and the list of what is left.
 *
 * This module deliberately imports no server action and holds no submission
 * state. It cannot save, cannot upload, and cannot change a version, because it
 * has nothing to call. That is asserted rather than assumed: see
 * `guidance-integrity.test.ts`, which walks the import graph of every guidance
 * file and fails if a write path ever appears in one.
 */

// --------------------------------------------------------------------------
// A question
// --------------------------------------------------------------------------

export interface GuidedFieldProps {
  /** Schema path, indices included: `learning.bugsFixed.0.howFixed`. */
  path: string;
  required?: boolean;
  error?: string;
  /** Replaces the guidance label where a repeated group already names it. */
  label?: string;
  /** Hides the requirement line where the group states it once for all entries. */
  hideRequirement?: boolean;
  children: (aria: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => React.ReactNode;
}

/**
 * A form field that explains itself.
 *
 * Label, helper, control, then a quiet footer carrying the rule and the way in
 * to an example. The rule is on screen before anyone types — a learner should
 * never find out about a minimum by tripping over it, which was the whole
 * reason the review screen used to be the first place anything was explained.
 */
export function GuidedField({
  path,
  required,
  error,
  label,
  hideRequirement,
  children,
}: GuidedFieldProps) {
  const guide = fieldGuide(path);
  const id = fieldDomId(path);
  const requirement = guide && !hideRequirement ? requirementLine(guide) : undefined;

  const hintId = guide?.helper ? `${id}-hint` : undefined;
  const ruleId = requirement ? `${id}-rule` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, ruleId, errorId].filter(Boolean).join(' ') || undefined;

  /*
   * Capped at a readable measure.
   *
   * The form column is ~810px on a 1440px screen, and a `w-full` textarea in it
   * runs to about 95 characters a line — past the point where a reader loses
   * the start of the next one. Typographic convention is 45–75; 42rem lands at
   * roughly 80, which keeps long answers readable without leaving the card
   * looking half-empty.
   *
   * A no-op inside the two-column grids, where the cell is already narrower.
   */
  return (
    <div className="max-w-2xl space-y-1.5" data-field={path}>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label ?? guide?.label ?? id}
        {required && (
          <span className="ml-1 text-brand-text" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {guide?.helper && (
        <p id={hintId} className="text-sm text-muted">
          {guide.helper}
        </p>
      )}

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })}

      {(requirement || guide?.example) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {requirement ? (
            <p id={ruleId} className="text-xs text-muted">
              {requirement}
            </p>
          ) : (
            <span />
          )}
          {guide?.example && <FieldExample path={path} />}
        </div>
      )}

      {error && (
        <p id={errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A worked answer, on request.
 *
 * Expands in place rather than opening a dialog: on a 360px screen a modal over
 * a form you are halfway through typing into is the worst of both worlds — it
 * hides the question the example is meant to explain, and it closes the
 * keyboard.
 *
 * There is no button to copy this into the field, and there will not be. The
 * example is here so a learner understands what is being asked; an answer they
 * did not write is worth nothing to them and nothing to us.
 */
export function FieldExample({ path }: { path: string }) {
  const guide = fieldGuide(path);
  const [open, setOpen] = React.useState(false);
  const id = `${fieldDomId(path)}-example`;

  if (!guide?.example) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={id}
        data-testid={`see-example-${fieldDomId(path)}`}
        className="shrink-0 text-xs font-semibold text-brand-text underline underline-offset-4 hover:text-ink"
      >
        {open ? 'Hide example' : 'See example'}
      </button>

      {open && (
        <div
          id={id}
          data-testid={`example-${fieldDomId(path)}`}
          className="mt-1 w-full rounded-[10px] border border-brand-edge bg-brand-tint px-3.5 py-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-text">Example</p>
          <p className="mt-1.5 text-sm text-ink">{guide.example}</p>
          {guide.exampleNote && <p className="mt-2 text-xs text-muted">{guide.exampleNote}</p>}
          <p className="mt-2 text-xs text-muted">
            This is about a made-up project. Write your answer about your own.
          </p>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------
// What's missing
// --------------------------------------------------------------------------

/**
 * The gap between here and submitted, for one step.
 *
 * Collapsed by default, because a step you have not started yet is missing
 * everything and a list saying so is just the form again. Someone who wants to
 * know opens it; someone typing is not interrupted.
 */
export function MissingPanel({
  step,
  completeness,
  onJump,
  defaultOpen = false,
}: {
  step: LearnerStepKey;
  completeness: SubmissionCompleteness;
  onJump: (item: MissingItem) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const items = React.useMemo(
    () => collectMissingItems(completeness).byStep[step],
    [completeness, step],
  );

  if (items.length === 0) return null;

  return (
    <div
      className="rounded-[10px] border border-warning/40 bg-warning-tint"
      data-testid={`missing-panel-${step}`}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm font-bold text-ink">What&rsquo;s missing?</span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-warning" data-testid={`missing-count-${step}`}>
            {missingSummaryLabel(items.length)}
          </span>
          <span aria-hidden="true" className={cn('text-muted transition-transform', open && 'rotate-90')}>
            ›
          </span>
        </span>
      </button>

      {open && (
        <ul className="space-y-1 border-t border-warning/30 px-2 pb-2 pt-2">
          {items.map((item) => (
            <li key={item.path}>
              <MissingRow item={item} onJump={onJump} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One thing to do. Clicking it puts the cursor in the box that fixes it. */
export function MissingRow({
  item,
  onJump,
}: {
  item: MissingItem;
  onJump: (item: MissingItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onJump(item)}
      data-testid={`missing-item-${item.fieldId}`}
      className="flex w-full min-h-11 items-start gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface/60"
    >
      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{item.text}</span>
        {item.detail && <span className="block text-xs text-muted">{item.detail}</span>}
      </span>
    </button>
  );
}

/**
 * Send the learner to the thing they clicked.
 *
 * Focus, not just scroll: on a phone, scrolling a field into view and leaving
 * the keyboard closed means a second tap to start typing, and the field the
 * learner actually wanted is by then behind the keyboard.
 */
export function focusField(fieldId: string): void {
  if (typeof document === 'undefined') return;

  const target =
    document.getElementById(fieldId) ??
    document.querySelector<HTMLElement>(`[data-field-anchor="${fieldId}"]`);
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    target.focus({ preventScroll: true });
  } else {
    // A section rather than a control — make it focusable once so the jump
    // still lands somewhere for a keyboard or screen-reader user.
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
}

// --------------------------------------------------------------------------
// Step heading
// --------------------------------------------------------------------------

export function StepHeading({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 border-b border-line pb-5">
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      <p className="mt-1.5 text-sm text-muted">{intro}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
