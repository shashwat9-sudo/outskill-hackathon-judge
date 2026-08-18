'use client';

import * as React from 'react';
import {
  DECLARATION_KEYS,
  DECLARATION_TEXT,
  FINAL_SUBMIT_CONFIRMATION,
  FINAL_SUBMIT_EXPLANATION,
  FIELD_GUIDANCE,
  LEARNER_STEPS,
  STEP_GUIDANCE,
  SUBMISSION_STEPS,
  collectMissingItems,
  evaluateCompleteness,
  missingSummaryLabel,
  type CohortIdea,
  type DeclarationKey,
  type LearnerStepKey,
  type MissingItem,
  type ParticipantView,
  resolveArtifactsStep,
} from '@ohj/shared/client';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Progress,
  Stepper,
  Textarea,
  cn,
  type StepState,
} from '@/components/ui';
import {
  confirmDeckUploadAction,
  createDeckUploadTicketAction,
  finalSubmitAction,
  saveDraftAction,
  setDemoVideoAction,
} from '@/server/participant-actions';
import { GuidedField, MissingPanel, StepHeading, focusField } from './guidance';
import { useLearnerGuidance } from './walkthrough';

/**
 * The six-step submission form.
 *
 * The six steps a participant sees are not quite the six schema steps: the
 * declarations are folded into "Review and submit", where they belong
 * editorially. Validation is unchanged — `evaluateCompleteness` still checks
 * all six schema steps, and Final Submit is re-validated on the server.
 *
 * Every question, helper line, rule and example is read from the shared
 * guidance module rather than written here, so the form, the worked example and
 * the written guide say the same thing by construction. Nothing in that module
 * can write; guidance explains the question and never answers it.
 *
 * Drafts autosave on a debounce, so a team never loses work to a closed tab.
 */

const AUTOSAVE_DEBOUNCE_MS = 1200;

/** How many outstanding items a Review row lists before it summarises the rest. */
const REVIEW_ITEMS_SHOWN = 4;

type DraftShape = Record<string, Record<string, unknown>>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SubmissionForm({ view }: { view: ParticipantView }) {
  const { step, goToStep } = useLearnerGuidance();
  const [draft, setDraft] = React.useState<DraftShape>(() => hydrateDraft(view));
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const [conflict, setConflict] = React.useState(false);

  /**
   * Whether anything typed here is still only in this browser.
   *
   * Completeness is computed from local form state, so it happily reads
   * "6 of 6 complete" for work that has never reached the server. During the
   * acceptance run an operator re-entered lost declarations, saw Complete, and
   * none of it had been written — the tab's version was stale and every save
   * was being refused. Final submission is gated on this, so a screen showing
   * "ready" cannot mean "ready, but only here".
   */
  const [unsaved, setUnsaved] = React.useState(false);

  /** Set when a "what's missing" row is clicked; consumed after the step renders. */
  const [pendingFocus, setPendingFocus] = React.useState<string | null>(null);

  /** Mobile only: whether the six-step list is expanded. Always open on desktop. */
  const [stepsOpen, setStepsOpen] = React.useState(false);

  const readOnly = !view.canEdit;
  const completeness = React.useMemo(() => evaluateCompleteness(draft), [draft]);
  const missing = React.useMemo(() => collectMissingItems(completeness), [completeness]);

  const completedCount = completeness.steps.filter((s) => s.complete).length;

  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = React.useRef<DraftShape | null>(null);

  /**
   * The version this browser last successfully wrote.
   *
   * Kept in a ref rather than state: an autosave fired from a debounce timer
   * must read the value at the moment it runs, not the one captured when the
   * timer was scheduled.
   */
  const versionRef = React.useRef(view.submission.version);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const persist = React.useCallback(
    async (payload: DraftShape) => {
      setSaveState('saving');
      const result = await saveDraftAction(payload, versionRef.current);
      if (result.ok) {
        // The version the database now holds, not a local increment. Counting
        // our own successes drifts the moment anything else writes.
        versionRef.current = result.version ?? versionRef.current + 1;
        pendingRef.current = null;
        setUnsaved(false);
        setSaveState('saved');
        setSaveError(null);
      } else if (result.conflict) {
        // A teammate saved first. Stop autosaving into a losing battle and tell
        // them plainly, rather than letting them keep typing into a draft that
        // will never be written.
        if (timerRef.current) clearTimeout(timerRef.current);
        setConflict(true);
        setUnsaved(true);
        setSaveState('error');
        setSaveError(result.conflict.message);
      } else {
        setUnsaved(true);
        setSaveState('error');
        setSaveError(result.error ?? 'Could not save.');
      }
      return result.ok;
    },
    [],
  );

  const scheduleSave = React.useCallback(
    (next: DraftShape) => {
      if (readOnly) return;
      pendingRef.current = next;
      setUnsaved(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void persist(next), AUTOSAVE_DEBOUNCE_MS);
    },
    [readOnly, persist],
  );

  const update = React.useCallback(
    (stepKey: string, patch: Record<string, unknown>) => {
      setDraft((current) => {
        const next = { ...current, [stepKey]: { ...(current[stepKey] ?? {}), ...patch } };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const saveNow = React.useCallback(async () => {
    if (readOnly) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    await persist(pendingRef.current ?? draft);
  }, [draft, persist, readOnly]);

  /**
   * Follow a "what's missing" row to the field that fixes it.
   *
   * The step has to change before the field exists, so the focus is deferred to
   * the frame after the render rather than attempted here, where the target is
   * still unmounted.
   */
  const jumpTo = React.useCallback(
    (item: MissingItem) => {
      if (item.step !== step) goToStep(item.step);
      setPendingFocus(item.fieldId);
    },
    [step, goToStep],
  );

  React.useEffect(() => {
    if (!pendingFocus) return;
    const frame = window.requestAnimationFrame(() => {
      focusField(pendingFocus);
      setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingFocus, step]);

  const onFinalSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    // Flush any pending autosave first, so the server validates what the team
    // can actually see on screen.
    if (timerRef.current) clearTimeout(timerRef.current);
    if (pendingRef.current) await saveDraftAction(pendingRef.current, versionRef.current);

    const result = await finalSubmitAction(confirmation);
    setSubmitting(false);
    if (result.ok) {
      // The route re-renders as the receipt page once the submission locks.
      window.location.reload();
    } else {
      setSubmitError(result.error ?? 'Could not submit.');
    }
  };

  const stepperSteps = LEARNER_STEPS.map((key) => {
    const state = stepState(key, draft, completeness);
    const outstanding = missing.byStep[key].length;
    return {
      key,
      label: STEP_GUIDANCE[key].label,
      state,
      note: state === 'attention' && outstanding > 0 ? `${outstanding} left` : undefined,
    };
  });

  const index = LEARNER_STEPS.indexOf(step);
  const previous = index > 0 ? LEARNER_STEPS[index - 1] : null;
  const next = index < LEARNER_STEPS.length - 1 ? LEARNER_STEPS[index + 1] : null;

  /*
   * `grid-cols-1` rather than a bare `grid`.
   *
   * An implicit `auto` track sizes to its content's max-content width, and the
   * mobile step strip is a nowrap row six chips long. A scroll container clamps
   * its *min*-content to zero but not its max-content, so the column grew to
   * 1,017px inside a 360px screen and the whole page scrolled sideways.
   * `grid-cols-1` is `minmax(0, 1fr)`, which cannot exceed the viewport — and
   * the strip then scrolls, as it was meant to.
   */
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_1fr]">
      {/* Desktop: persistent side progress. Mobile: compact top indicator. */}
      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <Card tone="raised" padding="compact">
          {/* The bar repeats what the marks on the six steps already say, and on
              a phone every pixel above the first question is one a learner has
              to scroll past. */}
          <div className="hidden lg:block">
            <Progress value={completedCount} max={SUBMISSION_STEPS.length} label="Progress" />
          </div>
          <p className="text-xs text-muted lg:mt-2" data-testid="percent-complete">
            {completedCount} of {SUBMISSION_STEPS.length} steps complete
          </p>
          <p className="mt-1 text-xs text-muted">Your answers save automatically.</p>

          {/*
            Folded away on a phone, and only on a phone.

            Six steps listed vertically is 344px of navigation above the first
            question — two thirds of a 360px screen a learner scrolls past every
            time they open the form. Collapsed, the same card says where they
            are and opens the full list on a tap.

            From 640px up there is room to wrap all six across the card, so they
            are shown: a tablet that hides its navigation behind a toggle is a
            stretched phone, and this is the width where that shows most.
          */}
          <button
            type="button"
            onClick={() => setStepsOpen((open) => !open)}
            aria-expanded={stepsOpen}
            aria-controls="submission-steps"
            data-testid="toggle-steps"
            className="mt-3 flex min-h-11 w-full items-center justify-between gap-3 rounded-[10px] border border-line px-3 text-left text-sm font-semibold text-ink sm:hidden"
          >
            <span className="min-w-0 truncate">
              Step {index + 1} of {LEARNER_STEPS.length} · {STEP_GUIDANCE[step].label}
            </span>
            <span className="shrink-0 text-xs font-semibold text-brand-text">
              {stepsOpen ? 'Hide' : 'All steps'}
            </span>
          </button>

          <div
            id="submission-steps"
            className={cn('mt-3 sm:block lg:mt-5', !stepsOpen && 'hidden')}
          >
            <Stepper
              steps={stepperSteps}
              currentKey={step}
              onSelect={(key) => {
                goToStep(key as LearnerStepKey);
                setStepsOpen(false);
              }}
              orientation="responsive"
            />
          </div>
        </Card>
      </aside>

      {/* Room for the fixed action bar, so the last question is never under it. */}
      <div className="min-w-0 pb-24 lg:pb-0">
        {readOnly && (
          <Alert tone="info" className="mb-6">
            {view.windowMessage}
          </Alert>
        )}

        {conflict && (
          <Alert tone="warning" className="mb-6" testId="save-conflict">
            <p className="font-semibold">Your latest change wasn&rsquo;t saved</p>
            <p className="mt-1">
              This submission changed in another tab. Reload to continue safely — copy anything you
              still need from this screen first.
            </p>
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              onClick={() => window.location.reload()}
            >
              Reload and continue
            </Button>
          </Alert>
        )}

        <Card className="mb-4 pb-8">
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
            <StepHeading title={STEP_GUIDANCE[step].label} intro={STEP_GUIDANCE[step].intro}>
              {step !== 'review' && (
                <MissingPanel step={step} completeness={completeness} onJump={jumpTo} />
              )}
            </StepHeading>

            {step === 'team' && <TeamStep view={view} draft={draft} update={update} />}
            {step === 'product' && <ProductStep ideas={view.ideas} draft={draft} update={update} />}
            {step === 'live' && <LiveStep view={view} draft={draft} update={update} />}
            {step === 'artifacts' && <ArtifactsStep view={view} draft={draft} update={update} />}
            {step === 'learning' && <LearningStep draft={draft} update={update} />}
            {step === 'review' && (
              <ReviewStep
                completeness={completeness}
                draft={draft}
                update={update}
                confirmation={confirmation}
                setConfirmation={setConfirmation}
                onSubmit={onFinalSubmit}
                submitting={submitting}
                error={submitError}
                onJump={jumpTo}
                onGoToStep={goToStep}
                conflict={conflict}
                unsaved={unsaved}
              />
            )}
          </fieldset>
        </Card>

        {/*
          Pinned to the viewport on a phone, in the flow on a laptop.

          `sticky` was not enough: the form column begins well below the fold on
          a 360px screen, and a sticky element cannot leave its own containing
          block — so the actions were simply absent until a learner scrolled
          past the progress card to find them. Fixed puts the next step where a
          thumb already is.
        */}
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:static lg:rounded-[14px] lg:border lg:px-5 lg:py-4">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 lg:max-w-none">
            <SaveIndicator
              state={saveState}
              error={saveError}
              readOnly={readOnly}
              onRetry={saveNow}
            />
            {/*
              `min-w-0`, not `shrink-0`.

              `shrink-0` held this row at its max-content width — 365px inside a
              328px bar on a 360px screen — so "Save and continue", the one
              control every step ends with, sat off the right edge from step two
              onwards. Nothing scrolled sideways, because the bar clipped it,
              which is why it went unnoticed: the button was simply gone.
            */}
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              {previous && (
                <Button variant="ghost" onClick={() => goToStep(previous)}>
                  Previous
                </Button>
              )}
              {/*
                Hidden on a phone. Three buttons do not fit across 360px, and
                the one that would be dropped is the one autosave already does
                every 1.2 seconds — with the result stated right beside it.
              */}
              {!readOnly && (
                <Button variant="secondary" className="hidden sm:inline-flex" onClick={saveNow}>
                  Save draft
                </Button>
              )}
              {next && (
                <Button
                  className="min-w-0 flex-1 sm:flex-none"
                  onClick={async () => {
                    await saveNow();
                    goToStep(next);
                  }}
                >
                  Save and continue
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Where a step stands.
 *
 * "Not complete" is two different situations. A step nobody has opened is
 * ordinary progress; a step somebody filled most of and left is something to go
 * back to. Showing both as a blank circle hides the only one that matters.
 */
function stepState(
  key: LearnerStepKey,
  draft: DraftShape,
  completeness: ReturnType<typeof evaluateCompleteness>,
): StepState {
  if (key === 'review') {
    if (completeness.complete) return 'complete';
    return hasAnyContent(draft.declarations) ? 'attention' : 'untouched';
  }

  const summary = completeness.steps.find((s) => s.step === key);
  if (summary?.complete) return 'complete';
  return hasAnyContent(draft[key]) ? 'attention' : 'untouched';
}

/** Whether a learner has put anything at all into this part of the form. */
function hasAnyContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasAnyContent);
  if (typeof value === 'object') return Object.values(value).some(hasAnyContent);
  return false;
}

/** Groups related fields under a quiet heading. */
function Section({
  title,
  description,
  anchor,
  children,
}: {
  title: string;
  description?: string;
  /** Lets a "what's missing" row land on a group rather than a single control. */
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-9 last:mb-0" data-field-anchor={anchor}>
      <h3 className="text-xs font-bold uppercase tracking-wider text-brand-text">{title}</h3>
      {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

// --------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------

interface StepProps {
  draft: DraftShape;
  update: (step: string, patch: Record<string, unknown>) => void;
}

function TeamStep({ view, draft, update }: StepProps & { view: ParticipantView }) {
  const team = draft.team ?? {};
  const members = (team.members as { fullName?: string; contribution?: string }[]) ?? [];
  const setMembers = (nextMembers: unknown[]) => update('team', { members: nextMembers });

  return (
    <>
      <Section title="Team lead">
        <div className="grid gap-5 sm:grid-cols-2">
          <GuidedField path="team.groupNumber" required>
            {(aria) => (
              <Input
                {...aria}
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                value={String(team.groupNumber ?? view.team.groupNumber ?? '')}
                onChange={(e) => update('team', { groupNumber: e.target.value })}
              />
            )}
          </GuidedField>
          <GuidedField path="team.leadName" required>
            {(aria) => (
              <Input
                {...aria}
                value={String(team.leadName ?? '')}
                onChange={(e) => update('team', { leadName: e.target.value })}
              />
            )}
          </GuidedField>
          <GuidedField path="team.leadEmail" required>
            {(aria) => (
              <Input
                {...aria}
                type="email"
                inputMode="email"
                value={String(team.leadEmail ?? '')}
                onChange={(e) => update('team', { leadEmail: e.target.value })}
              />
            )}
          </GuidedField>
          <GuidedField path="team.leadPhone" required>
            {(aria) => (
              <Input
                {...aria}
                type="tel"
                inputMode="tel"
                value={String(team.leadPhone ?? '')}
                onChange={(e) => update('team', { leadPhone: e.target.value })}
              />
            )}
          </GuidedField>
        </div>
      </Section>

      <Section
        title="Who worked on this project?"
        description="Everyone who actively worked on it, and one line on what each person did."
        anchor="members"
      >
        <div className="space-y-4">
          {members.map((member, memberIndex) => (
            <div key={memberIndex} className="rounded-[10px] border border-line bg-canvas p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
                Member {memberIndex + 1}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <GuidedField path={`team.members.${memberIndex}.fullName`} required>
                  {(aria) => (
                    <Input
                      {...aria}
                      value={member.fullName ?? ''}
                      onChange={(e) => {
                        const nextMembers = [...members];
                        nextMembers[memberIndex] = { ...member, fullName: e.target.value };
                        setMembers(nextMembers);
                      }}
                    />
                  )}
                </GuidedField>
                <GuidedField path={`team.members.${memberIndex}.contribution`} required>
                  {(aria) => (
                    <Input
                      {...aria}
                      value={member.contribution ?? ''}
                      onChange={(e) => {
                        const nextMembers = [...members];
                        nextMembers[memberIndex] = { ...member, contribution: e.target.value };
                        setMembers(nextMembers);
                      }}
                    />
                  )}
                </GuidedField>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 text-danger"
                onClick={() => setMembers(members.filter((_, i) => i !== memberIndex))}
              >
                Remove member {memberIndex + 1}
              </Button>
            </div>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => setMembers([...members, { fullName: '', contribution: '', isActive: true }])}
        >
          + Add a team member
        </Button>
      </Section>
    </>
  );
}

function ProductStep({ ideas, draft, update }: StepProps & { ideas: CohortIdea[] }) {
  const product = draft.product ?? {};
  const shouldHave = (product.shouldHaveFeatures as string[]) ?? [];
  const selectedId = String(product.ideaId ?? '');

  return (
    <>
      <Section
        title="Which approved idea did you build?"
        description="Pick one. You can only build from the ideas approved for your cohort."
        anchor="ideaId"
      >
        <fieldset>
          <legend className="sr-only">Approved product ideas</legend>
          <div className="grid gap-3 sm:grid-cols-2" data-testid="idea-cards">
            {ideas.map((idea) => {
              const selected = idea.id === selectedId;
              return (
                <label
                  key={idea.id}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-[10px] border p-4 transition-colors',
                    selected
                      ? 'border-brand bg-brand-tint'
                      : 'border-line bg-canvas hover:border-brand-edge',
                  )}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="ideaId"
                      value={idea.id}
                      checked={selected}
                      onChange={() => update('product', { ideaId: idea.id })}
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="font-bold text-ink">{idea.title}</span>
                  </span>
                  <span className="mt-2 text-sm text-muted">{idea.description}</span>
                  {idea.expectedUseCase && (
                    <span className="mt-3 text-xs text-muted">
                      <span className="font-semibold text-ink">Typical use: </span>
                      {idea.expectedUseCase}
                    </span>
                  )}
                  {selected && idea.minimumCoreFlow.length > 0 && (
                    <span className="mt-3 block border-t border-brand-edge pt-3">
                      <span className="text-xs font-semibold text-ink">
                        A working version should let someone:
                      </span>
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted">
                        {idea.minimumCoreFlow.map((flow) => (
                          <li key={flow}>{flow}</li>
                        ))}
                      </ul>
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      </Section>

      <Section title="Your product">
        <GuidedField path="product.productName" required>
          {(aria) => (
            <Input
              {...aria}
              value={String(product.productName ?? '')}
              onChange={(e) => update('product', { productName: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="product.primaryUser" required>
          {(aria) => (
            <Input
              {...aria}
              value={String(product.primaryUser ?? '')}
              onChange={(e) => update('product', { primaryUser: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="product.exactProblem" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.exactProblem ?? '')}
              onChange={(e) => update('product', { exactProblem: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="product.oneSentencePromise" required>
          {(aria) => (
            <Input
              {...aria}
              value={String(product.oneSentencePromise ?? '')}
              onChange={(e) => update('product', { oneSentencePromise: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="product.briefDescription" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.briefDescription ?? '')}
              onChange={(e) => update('product', { briefDescription: e.target.value })}
            />
          )}
        </GuidedField>
      </Section>

      <Section title="Why AI, and what makes it different">
        <GuidedField path="product.whyAiNecessary" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.whyAiNecessary ?? '')}
              onChange={(e) => update('product', { whyAiNecessary: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="product.differentiation" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.differentiation ?? '')}
              onChange={(e) => update('product', { differentiation: e.target.value })}
            />
          )}
        </GuidedField>
      </Section>

      <Section title="What you built, and what you left out">
        <GuidedField path="product.mustHaveWorkflow" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.mustHaveWorkflow ?? '')}
              onChange={(e) => update('product', { mustHaveWorkflow: e.target.value })}
            />
          )}
        </GuidedField>

        <div>
          <p className="text-sm font-semibold text-ink">
            {FIELD_GUIDANCE['product.shouldHaveFeatures']!.label}
          </p>
          <p className="mt-1 text-sm text-muted">
            {FIELD_GUIDANCE['product.shouldHaveFeatures']!.helper}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((slot) => (
              <div key={slot}>
                <label
                  htmlFor={`shouldHaveFeatures-${slot}`}
                  className="block text-sm font-medium text-muted"
                >
                  {slot === 0 ? 'One more thing it does' : 'And one more'}
                </label>
                <Input
                  id={`shouldHaveFeatures-${slot}`}
                  className="mt-1.5"
                  value={shouldHave[slot] ?? ''}
                  onChange={(e) => {
                    const nextFeatures = [...shouldHave];
                    nextFeatures[slot] = e.target.value;
                    update('product', {
                      shouldHaveFeatures: nextFeatures.filter((v) => v && v.trim()),
                    });
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <GuidedField path="product.excludedFeatures" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.excludedFeatures ?? '')}
              onChange={(e) => update('product', { excludedFeatures: e.target.value })}
            />
          )}
        </GuidedField>
      </Section>
    </>
  );
}

function LiveStep({ view, draft, update }: StepProps & { view: ParticipantView }) {
  const live = draft.live ?? {};
  const steps = (live.coreTestSteps as { action?: string; expectedResult?: string }[]) ?? [];
  const loginRequired = Boolean(live.loginRequired);
  const setSteps = (nextSteps: unknown[]) => update('live', { coreTestSteps: nextSteps });

  return (
    <>
      <Section title="Your live product">
        <GuidedField path="live.productUrl" required>
          {(aria) => (
            <Input
              {...aria}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={String(live.productUrl ?? '')}
              onChange={(e) => update('live', { productUrl: e.target.value })}
            />
          )}
        </GuidedField>
      </Section>

      <Section title="Logging in">
        <Checkbox
          id="loginRequired"
          label={FIELD_GUIDANCE['live.loginRequired']!.label}
          description="If it does, give us a demo account so we can get in."
          checked={loginRequired}
          onChange={(e) => update('live', { loginRequired: e.target.checked })}
        />

        {loginRequired && (
          <div className="rounded-[10px] border border-line bg-canvas p-4">
            <p className="mb-4 text-sm text-muted">
              Encrypted before storage, masked in our dashboard, and never sent to an AI model. Use a
              demo account, never a real one.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <GuidedField path="live.demoUsername" required>
                {(aria) => (
                  <Input
                    {...aria}
                    autoComplete="off"
                    value={String(live.demoUsername ?? '')}
                    onChange={(e) => update('live', { demoUsername: e.target.value })}
                  />
                )}
              </GuidedField>
              <GuidedField path="live.demoPassword" required>
                {(aria) => (
                  <Input
                    {...aria}
                    type="password"
                    autoComplete="off"
                    value={String(live.demoPassword ?? '')}
                    onChange={(e) => update('live', { demoPassword: e.target.value })}
                  />
                )}
              </GuidedField>
            </div>
            <div className="mt-4">
              <GuidedField path="live.loginInstructions">
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={String(live.loginInstructions ?? '')}
                    onChange={(e) => update('live', { loginInstructions: e.target.value })}
                  />
                )}
              </GuidedField>
            </div>
            {view.hasStoredCredentials && (
              <p className="mt-3 text-sm text-success">✓ Credentials are stored and encrypted.</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="How should we test it?"
        description="Walk us through your main flow, one action at a time. Add at least 2 test steps."
        anchor="coreTestSteps"
      >
        <div className="space-y-3">
          {steps.map((entry, stepIndex) => (
            <div key={stepIndex} className="rounded-[10px] border border-line bg-canvas p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
                Step {stepIndex + 1}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <GuidedField path={`live.coreTestSteps.${stepIndex}.action`} required>
                  {(aria) => (
                    <Input
                      {...aria}
                      value={entry.action ?? ''}
                      onChange={(e) => {
                        const nextSteps = [...steps];
                        nextSteps[stepIndex] = { ...entry, action: e.target.value };
                        setSteps(nextSteps);
                      }}
                    />
                  )}
                </GuidedField>
                <GuidedField path={`live.coreTestSteps.${stepIndex}.expectedResult`} required>
                  {(aria) => (
                    <Input
                      {...aria}
                      value={entry.expectedResult ?? ''}
                      onChange={(e) => {
                        const nextSteps = [...steps];
                        nextSteps[stepIndex] = { ...entry, expectedResult: e.target.value };
                        setSteps(nextSteps);
                      }}
                    />
                  )}
                </GuidedField>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 text-danger"
                onClick={() => setSteps(steps.filter((_, i) => i !== stepIndex))}
              >
                Remove step {stepIndex + 1}
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSteps([...steps, { action: '', expectedResult: '' }])}
        >
          + Add a step
        </Button>
      </Section>

      <Section title="Testing safely">
        <GuidedField path="live.safeSampleInputs" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.safeSampleInputs ?? '')}
              onChange={(e) => update('live', { safeSampleInputs: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="live.resetInstructions" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.resetInstructions ?? '')}
              onChange={(e) => update('live', { resetInstructions: e.target.value })}
            />
          )}
        </GuidedField>
        <GuidedField path="live.knownLimitations" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.knownLimitations ?? '')}
              onChange={(e) => update('live', { knownLimitations: e.target.value })}
            />
          )}
        </GuidedField>
      </Section>
    </>
  );
}

function ArtifactsStep({ view, draft, update }: StepProps & { view: ParticipantView }) {
  const artifacts = draft.artifacts ?? {};
  const deck = view.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = view.artifacts.find((a) => a.kind === 'demo_video');

  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadPercent, setUploadPercent] = React.useState(0);
  const [videoUrl, setVideoUrl] = React.useState(video?.externalUrl ?? '');
  const [videoError, setVideoError] = React.useState<string | null>(null);
  const [videoSaved, setVideoSaved] = React.useState(false);

  /**
   * Straight to Storage, not through the server.
   *
   * Three steps: ask for permission to write one object, send the bytes to the
   * URL that comes back, then ask the server to check what arrived. The file
   * never touches a serverless function, which is the only way a 25 MB deck can
   * work at all — and the server still decides where it goes and whether it
   * counts.
   *
   * If any step fails the team's previous deck is untouched: the bytes go to a
   * new path every time, and the old one is only removed after the new one has
   * been verified and recorded.
   */
  const onUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadPercent(0);

    try {
      const ticket = await createDeckUploadTicketAction({
        filename: file.name,
        byteSize: file.size,
        mimeType: file.type,
      });
      if (!ticket.ok || !ticket.uploadUrl || !ticket.storagePath) {
        setUploading(false);
        setUploadError(ticket.error ?? 'Could not start the upload.');
        return;
      }

      await putWithProgress(ticket.uploadUrl, file, setUploadPercent);

      const confirmed = await confirmDeckUploadAction({
        storagePath: ticket.storagePath,
        filename: file.name,
      });
      setUploading(false);
      if (!confirmed.ok) {
        setUploadError(confirmed.error ?? 'The upload could not be confirmed.');
        return;
      }
      window.location.reload();
    } catch {
      setUploading(false);
      setUploadError(
        'The upload did not complete, so your deck has not been saved. Check your connection and ' +
          'try again — if it keeps failing, tell the Outskill team before the deadline.',
      );
    }
  };

  const onSaveVideo = async () => {
    setVideoError(null);
    setVideoSaved(false);
    const result = await setDemoVideoAction(videoUrl);
    if (result.ok) setVideoSaved(true);
    else setVideoError(result.error ?? 'Could not save the link.');
  };

  return (
    <>
      <Section
        title="Your pitch deck"
        description="Upload one PDF deck. Export your slides as a PDF first — a link will not work. Maximum 25 MB."
        anchor="deckArtifactId"
      >
        {deck ? (
          <div className="flex flex-wrap items-center gap-4 rounded-[10px] border border-success/40 bg-success-tint p-4">
            <span aria-hidden="true" className="text-2xl">
              📄
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">{deck.originalFilename}</p>
              <p className="text-sm text-muted">
                {((deck.byteSize ?? 0) / 1024 / 1024).toFixed(1)} MB · uploaded
              </p>
            </div>
            <label
              htmlFor="deck-upload"
              className="min-h-11 cursor-pointer rounded-[10px] border border-line bg-surface-soft px-3.5 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
            >
              Replace file
            </label>
          </div>
        ) : (
          <label
            htmlFor="deck-upload"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border-2 border-dashed border-line bg-canvas p-8 text-center transition-colors hover:border-brand-edge"
          >
            <span aria-hidden="true" className="text-3xl">
              📄
            </span>
            <span className="font-semibold text-ink">Upload your pitch deck (PDF)</span>
            <span className="text-sm text-muted">This must be a PDF file — a link will not work.</span>
          </label>
        )}

        <input
          id="deck-upload"
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Choose a PDF pitch deck"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUpload(file);
          }}
        />

        {uploading && (
          <div className="space-y-1.5" data-testid="deck-upload-progress">
            <Progress value={uploadPercent} max={100} label="Uploading" />
            <p className="text-sm text-muted">
              {uploadPercent < 100
                ? `Uploading… ${uploadPercent}%`
                : 'Checking the file we received…'}
            </p>
          </div>
        )}
        {uploadError && (
          <p role="alert" className="text-sm font-medium text-danger">
            {uploadError}
          </p>
        )}
      </Section>

      <Section title="Your demo video" description="Three minutes or less.">
        <GuidedField path="artifacts.demoVideoUrl" required error={videoError ?? undefined}>
          {(aria) => (
            <div className="flex flex-wrap gap-2">
              <Input
                {...aria}
                type="url"
                inputMode="url"
                placeholder="https://www.loom.com/share/…"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="min-w-0 flex-1"
              />
              <Button variant="secondary" onClick={onSaveVideo}>
                Save link
              </Button>
            </div>
          )}
        </GuidedField>
        {(videoSaved || video?.externalUrl) && !videoError && (
          <p className="text-sm text-success">✓ Saved: {videoUrl || video?.externalUrl}</p>
        )}

        <Checkbox
          id="demoUnderThreeMinutes"
          label={FIELD_GUIDANCE['artifacts.demoUnderThreeMinutes']!.label}
          description="Required. Longer videos are not watched in full."
          checked={Boolean(artifacts.demoUnderThreeMinutes)}
          onChange={(e) => update('artifacts', { demoUnderThreeMinutes: e.target.checked })}
        />
      </Section>

      <Section title="Templates" description="Everything you need to build a compliant deck.">
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/resources/pitch-template"
            className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
          >
            Download pitch-deck template
          </a>
          <a
            href="/api/resources/instructions"
            className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
          >
            Download submission instructions
          </a>
        </div>
      </Section>
    </>
  );
}

function LearningStep({ draft, update }: StepProps) {
  const learning = draft.learning ?? {};
  const bugs = (learning.bugsFixed as { description?: string; howFixed?: string }[]) ?? [{}, {}, {}];

  const setBug = (bugIndex: number, patch: Record<string, string>) => {
    const nextBugs = [...bugs];
    nextBugs[bugIndex] = { ...nextBugs[bugIndex], ...patch };
    update('learning', { bugsFixed: nextBugs });
  };

  return (
    <>
      <Section
        title="Three things that went wrong, and how you fixed them"
        description="Straight from the bug log in your workbook. All three are required."
        anchor="bugsFixed"
      >
        {[0, 1, 2].map((bugIndex) => (
          <div key={bugIndex} className="rounded-[10px] border border-line bg-canvas p-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
              Bug {bugIndex + 1}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <GuidedField path={`learning.bugsFixed.${bugIndex}.description`} required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[bugIndex]?.description ?? ''}
                    onChange={(e) => setBug(bugIndex, { description: e.target.value })}
                  />
                )}
              </GuidedField>
              <GuidedField path={`learning.bugsFixed.${bugIndex}.howFixed`} required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[bugIndex]?.howFixed ?? ''}
                    onChange={(e) => setBug(bugIndex, { howFixed: e.target.value })}
                  />
                )}
              </GuidedField>
            </div>
          </div>
        ))}
      </Section>

      <Section title="What you chose, and why">
        {(['deliberatelyExcluded', 'majorTradeoff'] as const).map((key) => (
          <GuidedField key={key} path={`learning.${key}`} required>
            {(aria) => (
              <Textarea
                {...aria}
                value={String(learning[key] ?? '')}
                onChange={(e) => update('learning', { [key]: e.target.value })}
              />
            )}
          </GuidedField>
        ))}
      </Section>

      <Section title="What you learned">
        {(['day12ToDay13Changes', 'mostImportantLearning', 'nextSevenDayPlan'] as const).map((key) => (
          <GuidedField key={key} path={`learning.${key}`} required>
            {(aria) => (
              <Textarea
                {...aria}
                value={String(learning[key] ?? '')}
                onChange={(e) => update('learning', { [key]: e.target.value })}
              />
            )}
          </GuidedField>
        ))}
      </Section>

      <Section title="What you built it with">
        <div className="grid gap-5 sm:grid-cols-3">
          <GuidedField path="learning.builderStack" required>
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.builderStack ?? '')}
                onChange={(e) => update('learning', { builderStack: e.target.value })}
              />
            )}
          </GuidedField>
          <GuidedField path="learning.apisUsed">
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.apisUsed ?? '')}
                onChange={(e) => update('learning', { apisUsed: e.target.value })}
              />
            )}
          </GuidedField>
          <GuidedField path="learning.externalTemplates">
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.externalTemplates ?? '')}
                onChange={(e) => update('learning', { externalTemplates: e.target.value })}
              />
            )}
          </GuidedField>
        </div>
      </Section>
    </>
  );
}

/**
 * Review — a checklist, not a wall.
 *
 * Six rows, each either done or carrying the exact things still missing, every
 * one of them a link to the field that fixes it. The declarations sit
 * underneath, unticked, because a declaration nobody consciously made is not a
 * declaration.
 */
function ReviewStep({
  completeness,
  draft,
  update,
  confirmation,
  setConfirmation,
  onSubmit,
  submitting,
  error,
  onJump,
  onGoToStep,
  conflict,
  unsaved,
}: {
  completeness: ReturnType<typeof evaluateCompleteness>;
  draft: DraftShape;
  update: (step: string, patch: Record<string, unknown>) => void;
  confirmation: string;
  setConfirmation: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  onJump: (item: MissingItem) => void;
  onGoToStep: (step: LearnerStepKey) => void;
  /** A teammate wrote first; nothing typed here is being stored. */
  conflict: boolean;
  /** Local edits that have not been confirmed by the server. */
  unsaved: boolean;
}) {
  const declarations = draft.declarations ?? {};
  const missing = React.useMemo(() => collectMissingItems(completeness), [completeness]);
  const declarationsComplete =
    completeness.steps.find((s) => s.step === 'declarations')?.complete ?? false;

  /** The five content steps. Declarations are shown as themselves, below. */
  const rows = LEARNER_STEPS.filter((key) => key !== 'review').map((key) => {
    const summary = completeness.steps.find((s) => s.step === key);
    return { key, label: STEP_GUIDANCE[key].label, complete: summary?.complete ?? false };
  });

  return (
    <>
      <Section title="Your submission">
        <div className="space-y-3" data-testid="review-checklist">
          {rows.map((row) => {
            const outstanding = missing.byStep[row.key];
            return (
              <div
                key={row.key}
                data-testid={`review-row-${row.key}`}
                data-complete={row.complete}
                className={cn(
                  'rounded-[10px] border p-4',
                  row.complete ? 'border-line bg-canvas' : 'border-warning/40 bg-warning-tint',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <span
                      aria-hidden="true"
                      className={row.complete ? 'text-success' : 'text-warning'}
                    >
                      {row.complete ? '✓' : '⚠'}
                    </span>
                    <span>{row.label}</span>
                    <span className={cn('text-sm font-medium', row.complete ? 'text-success' : 'text-warning')}>
                      {row.complete
                        ? '— Complete'
                        : `— ${outstanding.length} thing${outstanding.length === 1 ? '' : 's'} missing`}
                    </span>
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const first = outstanding[0];
                      if (first) onJump(first);
                      else onGoToStep(row.key);
                    }}
                  >
                    {row.complete ? 'Check' : 'Fix this'}
                  </Button>
                </div>

                {/*
                  The first few, then a count.

                  A step nobody has started is missing everything, and listing
                  all twelve turns a checklist into the form again. Four is
                  enough to see what kind of thing is wanted; the rest are on
                  the step itself, where they can be answered.
                */}
                {outstanding.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {outstanding.slice(0, REVIEW_ITEMS_SHOWN).map((item) => (
                      <li key={item.path}>
                        <button
                          type="button"
                          onClick={() => onJump(item)}
                          data-testid={`review-missing-${item.fieldId}`}
                          className="flex w-full items-start gap-2 rounded-[6px] py-1 text-left text-sm text-ink underline decoration-warning/60 underline-offset-4 hover:decoration-ink"
                        >
                          <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
                          {item.text}
                        </button>
                      </li>
                    ))}
                    {outstanding.length > REVIEW_ITEMS_SHOWN && (
                      <li>
                        <button
                          type="button"
                          onClick={() => onGoToStep(row.key)}
                          data-testid={`review-more-${row.key}`}
                          className="py-1 text-sm font-semibold text-muted underline underline-offset-4 hover:text-ink"
                        >
                          …and {outstanding.length - REVIEW_ITEMS_SHOWN} more on this step
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Declarations" description="All seven are required. Read each one before you tick it.">
        <div className="space-y-4">
          {DECLARATION_KEYS.map((key: DeclarationKey) => (
            <Checkbox
              key={key}
              id={key}
              label={DECLARATION_TEXT[key]}
              checked={Boolean(declarations[key])}
              onChange={(e) => update('declarations', { [key]: e.target.checked })}
            />
          ))}
        </div>
        {!declarationsComplete && (
          <p className="text-sm text-warning" data-testid="declarations-outstanding">
            {missingSummaryLabel(missing.byStep.review.length)} to tick.
          </p>
        )}
      </Section>

      <Section title="Final submission">
        <div className="rounded-[10px] border-2 border-brand-edge bg-brand-tint p-5">
          <h4 className="font-bold text-ink">{FINAL_SUBMIT_EXPLANATION.title}</h4>
          <p className="mt-1.5 text-sm text-muted">{FINAL_SUBMIT_EXPLANATION.body}</p>
          <p className="mt-1.5 text-sm text-muted">
            If something is genuinely wrong afterwards, the Outskill team can reopen it for you.
          </p>

          {conflict || unsaved ? (
            <Alert tone="warning" className="mt-4" testId="not-persisted">
              <p className="font-semibold">
                {conflict
                  ? "Your latest change wasn't saved"
                  : 'Your latest changes are still saving'}
              </p>
              <p className="mt-2">
                {conflict
                  ? 'This submission changed in another tab. Reload to continue safely, then check your answers before submitting.'
                  : 'Wait for “Saved” before submitting, so what you send is what you can see.'}
              </p>
              {conflict && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-3 min-h-11 font-semibold underline"
                >
                  Reload and continue
                </button>
              )}
            </Alert>
          ) : completeness.complete ? (
            <>
              <div className="mt-5 max-w-sm">
                <div className="space-y-1.5">
                  <label htmlFor="confirmation" className="block text-sm font-semibold text-ink">
                    Type {FINAL_SUBMIT_CONFIRMATION} to confirm
                  </label>
                  <Input
                    id="confirmation"
                    value={confirmation}
                    autoComplete="off"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? 'confirmation-error' : undefined}
                    onChange={(e) => setConfirmation(e.target.value)}
                    placeholder={FINAL_SUBMIT_CONFIRMATION}
                  />
                  {error && (
                    <p id="confirmation-error" className="text-sm font-medium text-danger">
                      {error}
                    </p>
                  )}
                </div>
              </div>

              <Button
                className="mt-5 w-full sm:w-auto"
                size="lg"
                loading={submitting}
                disabled={confirmation !== FINAL_SUBMIT_CONFIRMATION || conflict || unsaved}
                onClick={onSubmit}
              >
                Final submit
              </Button>
            </>
          ) : (
            <p className="mt-4 text-sm font-semibold text-warning" data-testid="submit-blocked">
              {missingSummaryLabel(missing.total)} before you can submit. Every one of them is listed
              above, and each links to the answer that fixes it.
            </p>
          )}
        </div>
      </Section>
    </>
  );
}

// --------------------------------------------------------------------------
// Chrome
// --------------------------------------------------------------------------

function SaveIndicator({
  state,
  error,
  readOnly,
  onRetry,
}: {
  state: SaveState;
  error: string | null;
  readOnly: boolean;
  onRetry: () => void;
}) {
  if (readOnly) return <span />;

  return (
    <p aria-live="polite" className="min-w-0 text-sm text-muted" data-testid="save-status">
      {state === 'saving' && 'Saving…'}
      {state === 'saved' && <span className="text-success">✓ Saved</span>}
      {state === 'error' && (
        <span className="text-danger">
          {error ?? 'Your latest change wasn’t saved'}.{' '}
          <button type="button" onClick={onRetry} className="font-semibold underline">
            Retry
          </button>
        </span>
      )}
      {/* The reassurance is on screen already, in the progress card. Repeating
          it here costs a phone the width of the button beside it. */}
      {state === 'idle' && <span className="hidden sm:inline">Your answers save automatically</span>}
    </p>
  );
}

/**
 * PUT a file to a signed URL, reporting progress.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: fetch cannot report
 * upload progress. A learner sending 20 MB over hotel wifi on deadline night
 * needs to see that something is happening, and a spinner that sits still for
 * four minutes is indistinguishable from a page that has died.
 *
 * Supabase's signed upload URL carries its own token, so no credential is
 * attached here and none exists in this bundle to attach.
 */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url, true);
    request.setRequestHeader('content-type', 'application/pdf');

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      // The bucket refuses oversize and non-PDF uploads itself. Its message is
      // not written for a learner, so it is not shown to one.
      reject(new Error(`upload failed with status ${request.status}`));
    };
    request.onerror = () => reject(new Error('upload failed'));
    request.onabort = () => reject(new Error('upload cancelled'));
    request.send(file);
  });
}

/** Seed the client draft from what the server already stored. */
function hydrateDraft(view: ParticipantView): DraftShape {
  const stored = (view.submission.draftPayload ?? {}) as DraftShape;
  const submission = view.submission;

  return {
    team: {
      groupNumber: view.team.groupNumber,
      leadName: view.team.leadName,
      leadEmail: view.team.leadEmail,
      leadPhone: view.team.leadPhone,
      members: view.members.map((m) => ({
        fullName: m.fullName,
        contribution: m.contribution,
        isActive: m.isActive,
      })),
      ...(stored.team ?? {}),
    },
    product: {
      ideaId: submission.ideaId ?? '',
      productName: submission.productName ?? '',
      primaryUser: submission.primaryUser ?? '',
      exactProblem: submission.exactProblem ?? '',
      oneSentencePromise: submission.oneSentencePromise ?? '',
      briefDescription: submission.briefDescription ?? '',
      whyAiNecessary: submission.whyAiNecessary ?? '',
      differentiation: submission.differentiation ?? '',
      mustHaveWorkflow: submission.mustHaveWorkflow ?? '',
      shouldHaveFeatures: submission.shouldHaveFeatures ?? [],
      excludedFeatures: submission.excludedFeatures ?? '',
      ...(stored.product ?? {}),
    },
    live: {
      productUrl: submission.productUrl ?? '',
      loginRequired: submission.loginRequired,
      coreTestSteps: submission.coreTestSteps ?? [],
      safeSampleInputs: submission.safeSampleInputs ?? '',
      resetInstructions: submission.resetInstructions ?? '',
      knownLimitations: submission.knownLimitations ?? '',
      // Credential values never reach the client — only whether they exist.
      demoUsername: view.hasStoredCredentials ? 'stored' : '',
      demoPassword: view.hasStoredCredentials ? 'stored' : '',
      ...(stored.live ?? {}),
    },
    // Artifact rows are the authority; the draft payload only fills in the
    // declaration. See resolveArtifactsStep for why the order matters.
    artifacts: { ...resolveArtifactsStep(stored.artifacts, view.artifacts) },
    learning: {
      bugsFixed: submission.bugsFixed?.length ? submission.bugsFixed : [{}, {}, {}],
      deliberatelyExcluded: submission.deliberatelyExcluded ?? '',
      majorTradeoff: submission.majorTradeoff ?? '',
      day12ToDay13Changes: submission.day12ToDay13Changes ?? '',
      mostImportantLearning: submission.mostImportantLearning ?? '',
      nextSevenDayPlan: submission.nextSevenDayPlan ?? '',
      builderStack: submission.builderStack ?? '',
      apisUsed: submission.apisUsed ?? '',
      externalTemplates: submission.externalTemplates ?? '',
      ...(stored.learning ?? {}),
    },
    declarations: {
      ...(view.declarations
        ? Object.fromEntries(DECLARATION_KEYS.map((k) => [k, view.declarations?.[k] ?? false]))
        : {}),
      ...(stored.declarations ?? {}),
    },
  };
}
