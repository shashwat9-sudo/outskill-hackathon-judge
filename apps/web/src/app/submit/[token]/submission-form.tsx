'use client';

import * as React from 'react';
import {
  DECLARATION_KEYS,
  DECLARATION_TEXT,
  FINAL_SUBMIT_CONFIRMATION,
  SUBMISSION_STEPS,
  SUBMISSION_STEP_INTROS,
  SUBMISSION_STEP_LABELS,
  evaluateCompleteness,
  type CohortIdea,
  type DeclarationKey,
  type ParticipantView,
  type SubmissionStepKey,
} from '@ohj/shared/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Progress,
  Stepper,
  Textarea,
  cn,
} from '@/components/ui';
import {
  finalSubmitAction,
  saveDraftAction,
  setDemoVideoAction,
  uploadDeckAction,
} from '@/server/participant-actions';

/**
 * The six-step submission form.
 *
 * The six steps a participant sees are not quite the six schema steps: the
 * declarations are folded into "Review and submit", where they belong
 * editorially. Validation is unchanged — `evaluateCompleteness` still checks
 * all six schema steps, and Final Submit is re-validated on the server.
 *
 * Drafts autosave on a debounce, so a team never loses work to a closed tab.
 */

const AUTOSAVE_DEBOUNCE_MS = 1200;

/** UI steps, in the order a participant works through them. */
const UI_STEPS = [
  { key: 'team', label: 'Team' },
  { key: 'product', label: 'Product idea' },
  { key: 'live', label: 'Live product' },
  { key: 'artifacts', label: 'Demo and deck' },
  { key: 'learning', label: 'Learning evidence' },
  { key: 'review', label: 'Review and submit' },
] as const;

type UiStepKey = (typeof UI_STEPS)[number]['key'];
type DraftShape = Record<string, Record<string, unknown>>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SubmissionForm({ token, view }: { token: string; view: ParticipantView }) {
  const [step, setStep] = React.useState<UiStepKey>('team');
  const [draft, setDraft] = React.useState<DraftShape>(() => hydrateDraft(view));
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const readOnly = !view.canEdit;
  const completeness = React.useMemo(() => evaluateCompleteness(draft), [draft]);

  const completedCount = completeness.steps.filter((s) => s.complete).length;

  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = React.useRef<DraftShape | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const persist = React.useCallback(
    async (payload: DraftShape) => {
      setSaveState('saving');
      const result = await saveDraftAction(token, payload);
      if (result.ok) {
        setSaveState('saved');
        setSaveError(null);
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Could not save.');
      }
      return result.ok;
    },
    [token],
  );

  const scheduleSave = React.useCallback(
    (next: DraftShape) => {
      if (readOnly) return;
      pendingRef.current = next;
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

  const goTo = React.useCallback((next: UiStepKey) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onFinalSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    // Flush any pending autosave first, so the server validates what the team
    // can actually see on screen.
    if (timerRef.current) clearTimeout(timerRef.current);
    if (pendingRef.current) await saveDraftAction(token, pendingRef.current);

    const result = await finalSubmitAction(token, confirmation);
    setSubmitting(false);
    if (result.ok) {
      // The route re-renders as the receipt page once the submission locks.
      window.location.reload();
    } else {
      setSubmitError(result.error ?? 'Could not submit.');
    }
  };

  const stepperSteps = UI_STEPS.map((uiStep) => ({
    key: uiStep.key,
    label: uiStep.label,
    complete:
      uiStep.key === 'review'
        ? completeness.complete
        : (completeness.steps.find((s) => s.step === uiStep.key)?.complete ?? false),
  }));

  const index = UI_STEPS.findIndex((s) => s.key === step);
  const previous = index > 0 ? UI_STEPS[index - 1] : null;
  const next = index < UI_STEPS.length - 1 ? UI_STEPS[index + 1] : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[17rem_1fr]">
      {/* Desktop: persistent side progress. Mobile: compact top indicator. */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <Card tone="raised">
          <Progress value={completedCount} max={SUBMISSION_STEPS.length} label="Progress" />
          <p className="mt-2 text-xs text-muted" data-testid="percent-complete">
            {completedCount} of {SUBMISSION_STEPS.length} steps complete
          </p>

          <div className="mt-5">
            <Stepper
              steps={stepperSteps}
              currentKey={step}
              onSelect={(key) => goTo(key as UiStepKey)}
              orientation="responsive"
            />
          </div>
        </Card>
      </aside>

      <div className="min-w-0">
        {readOnly && (
          <Alert tone="info" className="mb-6">
            {view.submission.status === 'locked'
              ? 'Your submission is locked. Contact the Outskill team if you need it reopened.'
              : 'This cohort is not currently accepting changes.'}
          </Alert>
        )}

        <Card className="mb-4 pb-8">
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
            <StepIntro step={step} />

            {step === 'team' && <TeamStep view={view} draft={draft} update={update} />}
            {step === 'product' && <ProductStep ideas={view.ideas} draft={draft} update={update} />}
            {step === 'live' && <LiveStep view={view} draft={draft} update={update} />}
            {step === 'artifacts' && (
              <ArtifactsStep token={token} view={view} draft={draft} update={update} />
            )}
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
                onGoToStep={(key) => goTo(key as UiStepKey)}
              />
            )}
          </fieldset>
        </Card>

        {/* Sticky on mobile so the actions are always reachable; inline on desktop. */}
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-[14px] lg:border lg:px-5 lg:py-4">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SaveIndicator
              state={saveState}
              error={saveError}
              readOnly={readOnly}
              onRetry={saveNow}
            />
            <div className="flex flex-wrap justify-end gap-2">
              {previous && (
                <Button variant="ghost" onClick={() => goTo(previous.key)}>
                  Previous
                </Button>
              )}
              {!readOnly && (
                <Button variant="secondary" onClick={saveNow}>
                  Save draft
                </Button>
              )}
              {next && (
                <Button
                  onClick={async () => {
                    await saveNow();
                    goTo(next.key);
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

function StepIntro({ step }: { step: UiStepKey }) {
  const title =
    step === 'review' ? 'Review and submit' : SUBMISSION_STEP_LABELS[step as SubmissionStepKey];
  const intro =
    step === 'review'
      ? 'Check everything below, agree to the declarations, then make your final submission.'
      : SUBMISSION_STEP_INTROS[step as SubmissionStepKey];

  return (
    <div className="mb-7 border-b border-line pb-5">
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      <p className="mt-1.5 text-sm text-muted">{intro}</p>
    </div>
  );
}

/** Groups related fields under a quiet heading. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-9 last:mb-0">
      <h3 className="text-xs font-bold uppercase tracking-wider text-brand">{title}</h3>
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
          <Field
            id="groupNumber"
            label="Group number"
            required
            hint="The number Outskill assigned to your team."
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                max={999}
                value={String(team.groupNumber ?? view.team.groupNumber ?? '')}
                onChange={(e) => update('team', { groupNumber: e.target.value })}
              />
            )}
          </Field>
          <Field id="leadName" label="Team lead name" required>
            {(aria) => (
              <Input
                {...aria}
                value={String(team.leadName ?? '')}
                onChange={(e) => update('team', { leadName: e.target.value })}
              />
            )}
          </Field>
          <Field id="leadEmail" label="Team lead email" required>
            {(aria) => (
              <Input
                {...aria}
                type="email"
                value={String(team.leadEmail ?? '')}
                onChange={(e) => update('team', { leadEmail: e.target.value })}
              />
            )}
          </Field>
          <Field
            id="leadPhone"
            label="Team lead phone"
            required
            hint="Any format — spaces, hyphens and brackets are all fine."
          >
            {(aria) => (
              <Input
                {...aria}
                type="tel"
                value={String(team.leadPhone ?? '')}
                onChange={(e) => update('team', { leadPhone: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section
        title="Active members"
        description="Everyone who actively worked on the product, and what each person did."
      >
        <div className="space-y-4">
          {members.map((member, memberIndex) => (
            <div key={memberIndex} className="rounded-[10px] border border-line bg-canvas p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={`member-${memberIndex}-name`}
                  label={`Member ${memberIndex + 1} name`}
                  required
                >
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
                </Field>
                <Field
                  id={`member-${memberIndex}-contribution`}
                  label="What they did"
                  required
                  hint="One line is enough."
                >
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
                </Field>
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
        title="Approved challenge"
        description="Choose exactly one. You may only build from the ideas approved for your cohort."
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
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand-accent)]"
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

      <Section title="The problem">
        <Field id="productName" label="Product name" required>
          {(aria) => (
            <Input
              {...aria}
              value={String(product.productName ?? '')}
              onChange={(e) => update('product', { productName: e.target.value })}
            />
          )}
        </Field>
        <Field
          id="primaryUser"
          label="Primary user"
          required
          hint="Be specific. “Everyone” is not a user."
        >
          {(aria) => (
            <Input
              {...aria}
              value={String(product.primaryUser ?? '')}
              onChange={(e) => update('product', { primaryUser: e.target.value })}
            />
          )}
        </Field>
        <Field
          id="exactProblem"
          label="The exact problem you are solving"
          required
          hint="The recurring pain your user has today."
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.exactProblem ?? '')}
              onChange={(e) => update('product', { exactProblem: e.target.value })}
            />
          )}
        </Field>
        <Field
          id="oneSentencePromise"
          label="One-sentence promise"
          required
          hint="For X, we built Y so they can Z."
        >
          {(aria) => (
            <Input
              {...aria}
              value={String(product.oneSentencePromise ?? '')}
              onChange={(e) => update('product', { oneSentencePromise: e.target.value })}
            />
          )}
        </Field>
        <Field id="briefDescription" label="Brief description" required>
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.briefDescription ?? '')}
              onChange={(e) => update('product', { briefDescription: e.target.value })}
            />
          )}
        </Field>
      </Section>

      <Section title="Why AI, and what makes it different">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="whyAiNecessary"
            label="Why AI is necessary here"
            required
            hint="What does AI change about the outcome?"
          >
            {(aria) => (
              <Textarea
                {...aria}
                value={String(product.whyAiNecessary ?? '')}
                onChange={(e) => update('product', { whyAiNecessary: e.target.value })}
              />
            )}
          </Field>
          <Field id="differentiation" label="How this differs from a basic implementation" required>
            {(aria) => (
              <Textarea
                {...aria}
                value={String(product.differentiation ?? '')}
                onChange={(e) => update('product', { differentiation: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title="Scope" description="What you committed to, and what you deliberately left out.">
        <Field
          id="mustHaveWorkflow"
          label="Your single must-have workflow"
          required
          hint="The one end-to-end flow you committed to ship. This is what gets tested."
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.mustHaveWorkflow ?? '')}
              onChange={(e) => update('product', { mustHaveWorkflow: e.target.value })}
            />
          )}
        </Field>

        <div>
          <p className="mb-2 text-sm font-semibold text-ink">Should-have features (up to two)</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((slot) => (
              <Field key={slot} id={`shouldHave-${slot}`} label={`Should-have ${slot + 1}`}>
                {(aria) => (
                  <Input
                    {...aria}
                    value={shouldHave[slot] ?? ''}
                    onChange={(e) => {
                      const nextFeatures = [...shouldHave];
                      nextFeatures[slot] = e.target.value;
                      update('product', {
                        shouldHaveFeatures: nextFeatures.filter((v) => v && v.trim()),
                      });
                    }}
                  />
                )}
              </Field>
            ))}
          </div>
        </div>

        <Field
          id="excludedFeatures"
          label="Features you deliberately left out"
          required
          hint="Scoping decisions count in your favour — say what you parked and why."
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.excludedFeatures ?? '')}
              onChange={(e) => update('product', { excludedFeatures: e.target.value })}
            />
          )}
        </Field>
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
      <Section title="Product URL">
        <Field
          id="productUrl"
          label="Live product URL"
          required
          hint="Must start with https:// and open in a browser. Not a Drive folder, not a video link."
        >
          {(aria) => (
            <Input
              {...aria}
              type="url"
              placeholder="https://"
              value={String(live.productUrl ?? '')}
              onChange={(e) => update('live', { productUrl: e.target.value })}
            />
          )}
        </Field>
      </Section>

      <Section title="Login information">
        <Checkbox
          id="loginRequired"
          label="Our product requires a login"
          description="If it does, supply working demo credentials so the judge can get in."
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
              <Field id="demoUsername" label="Demo username" required>
                {(aria) => (
                  <Input
                    {...aria}
                    autoComplete="off"
                    value={String(live.demoUsername ?? '')}
                    onChange={(e) => update('live', { demoUsername: e.target.value })}
                  />
                )}
              </Field>
              <Field id="demoPassword" label="Demo password" required>
                {(aria) => (
                  <Input
                    {...aria}
                    type="password"
                    autoComplete="off"
                    value={String(live.demoPassword ?? '')}
                    onChange={(e) => update('live', { demoPassword: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="mt-4">
              <Field id="loginInstructions" label="Login instructions">
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={String(live.loginInstructions ?? '')}
                    onChange={(e) => update('live', { loginInstructions: e.target.value })}
                  />
                )}
              </Field>
            </div>
            {view.hasStoredCredentials && (
              <p className="mt-3 text-sm text-success">✓ Credentials are stored and encrypted.</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Core test scenario"
        description="Walk us through your must-have flow, step by step, with what should happen each time. At least two steps."
      >
        <div className="space-y-3">
          {steps.map((entry, stepIndex) => (
            <div
              key={stepIndex}
              className="grid gap-4 rounded-[10px] border border-line bg-canvas p-4 sm:grid-cols-2"
            >
              <Field id={`step-${stepIndex}-action`} label={`Step ${stepIndex + 1}`} required>
                {(aria) => (
                  <Input
                    {...aria}
                    placeholder="Click “Create trip”"
                    value={entry.action ?? ''}
                    onChange={(e) => {
                      const nextSteps = [...steps];
                      nextSteps[stepIndex] = { ...entry, action: e.target.value };
                      setSteps(nextSteps);
                    }}
                  />
                )}
              </Field>
              <Field id={`step-${stepIndex}-expected`} label="What should happen" required>
                {(aria) => (
                  <Input
                    {...aria}
                    placeholder="A trip form opens"
                    value={entry.expectedResult ?? ''}
                    onChange={(e) => {
                      const nextSteps = [...steps];
                      nextSteps[stepIndex] = { ...entry, expectedResult: e.target.value };
                      setSteps(nextSteps);
                    }}
                  />
                )}
              </Field>
              <div className="sm:col-span-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setSteps(steps.filter((_, i) => i !== stepIndex))}
                >
                  Remove step {stepIndex + 1}
                </Button>
              </div>
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

      <Section title="Test data and cleanup">
        <Field
          id="safeSampleInputs"
          label="Safe sample inputs"
          required
          hint="Example data that is safe for us to type into your product."
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.safeSampleInputs ?? '')}
              onChange={(e) => update('live', { safeSampleInputs: e.target.value })}
            />
          )}
        </Field>
        <Field
          id="resetInstructions"
          label="Reset or cleanup instructions"
          required
          hint="How should we remove anything we create while testing?"
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.resetInstructions ?? '')}
              onChange={(e) => update('live', { resetInstructions: e.target.value })}
            />
          )}
        </Field>
      </Section>

      <Section title="Known limitations">
        <Field
          id="knownLimitations"
          label="What does not work yet"
          required
          hint="Being upfront is better than us finding it."
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(live.knownLimitations ?? '')}
              onChange={(e) => update('live', { knownLimitations: e.target.value })}
            />
          )}
        </Field>
      </Section>
    </>
  );
}

function ArtifactsStep({
  token,
  view,
  draft,
  update,
}: StepProps & { token: string; view: ParticipantView }) {
  const artifacts = draft.artifacts ?? {};
  const deck = view.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = view.artifacts.find((a) => a.kind === 'demo_video');

  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [videoUrl, setVideoUrl] = React.useState(video?.externalUrl ?? '');
  const [videoError, setVideoError] = React.useState<string | null>(null);
  const [videoSaved, setVideoSaved] = React.useState(false);

  const onUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    const formData = new FormData();
    formData.append('deck', file);
    const result = await uploadDeckAction(token, formData);
    setUploading(false);
    if (!result.ok) setUploadError(result.error ?? 'Upload failed.');
    else window.location.reload();
  };

  const onSaveVideo = async () => {
    setVideoError(null);
    setVideoSaved(false);
    const result = await setDemoVideoAction(token, videoUrl);
    if (result.ok) setVideoSaved(true);
    else setVideoError(result.error ?? 'Could not save the link.');
  };

  return (
    <>
      <Section title="Pitch deck" description="Export your deck as a PDF. Maximum 25 MB.">
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
              className="cursor-pointer rounded-[10px] border border-line bg-surface-soft px-3.5 py-2 text-sm font-semibold text-ink hover:border-brand-edge"
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

        {uploading && <p className="text-sm text-muted">Uploading…</p>}
        {uploadError && (
          <p role="alert" className="text-sm font-medium text-danger">
            {uploadError}
          </p>
        )}
      </Section>

      <Section title="Product walkthrough" description="A short demo video of three minutes or less.">
        <Field
          id="demoVideoUrl"
          label="Demo video link"
          required
          hint="A Loom, YouTube, Drive or Vimeo link."
          error={videoError ?? undefined}
        >
          {(aria) => (
            <div className="flex flex-wrap gap-2">
              <Input
                {...aria}
                type="url"
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
        </Field>
        {(videoSaved || video?.externalUrl) && !videoError && (
          <p className="text-sm text-success">✓ Saved: {videoUrl || video?.externalUrl}</p>
        )}

        <Checkbox
          id="demoUnderThreeMinutes"
          label="Our demo video is three minutes or shorter"
          description="Required. Longer videos are not watched in full."
          checked={Boolean(artifacts.demoUnderThreeMinutes)}
          onChange={(e) => update('artifacts', { demoUnderThreeMinutes: e.target.checked })}
        />
      </Section>

      <Section title="Templates" description="Everything you need to build a compliant deck.">
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/resources/pitch-template"
            className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
          >
            Download pitch-deck template
          </a>
          <a
            href="/api/resources/instructions"
            className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
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
        title="Bugs you found and fixed"
        description="Three of them. This comes straight from the bug log in your workbook."
      >
        {[0, 1, 2].map((bugIndex) => (
          <div key={bugIndex} className="rounded-[10px] border border-line bg-canvas p-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
              Bug {bugIndex + 1}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`bug-${bugIndex}-description`} label="What was broken" required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[bugIndex]?.description ?? ''}
                    onChange={(e) => setBug(bugIndex, { description: e.target.value })}
                  />
                )}
              </Field>
              <Field id={`bug-${bugIndex}-fix`} label="How you fixed it" required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[bugIndex]?.howFixed ?? ''}
                    onChange={(e) => setBug(bugIndex, { howFixed: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Scope and trade-offs">
        {(
          [
            ['deliberatelyExcluded', 'One feature you deliberately excluded', 'And why you parked it.'],
            ['majorTradeoff', 'One major trade-off you made', 'What you gave up, and what you gained.'],
          ] as const
        ).map(([key, label, hint]) => (
          <Field key={key} id={key} label={label} required hint={hint}>
            {(aria) => (
              <Textarea
                {...aria}
                value={String(learning[key] ?? '')}
                onChange={(e) => update('learning', { [key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </Section>

      <Section title="Progress and learning">
        {(
          [
            ['day12ToDay13Changes', 'What changed from Day 12 to Day 13', 'Be specific.'],
            ['mostImportantLearning', 'Your most important learning', ''],
            ['nextSevenDayPlan', 'Your next seven-day plan', 'What you would do first.'],
          ] as const
        ).map(([key, label, hint]) => (
          <Field key={key} id={key} label={label} required hint={hint || undefined}>
            {(aria) => (
              <Textarea
                {...aria}
                value={String(learning[key] ?? '')}
                onChange={(e) => update('learning', { [key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </Section>

      <Section title="What you built with">
        <div className="grid gap-5 sm:grid-cols-3">
          <Field id="builderStack" label="Builder / stack used" required>
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.builderStack ?? '')}
                onChange={(e) => update('learning', { builderStack: e.target.value })}
              />
            )}
          </Field>
          <Field id="apisUsed" label="APIs / services used">
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.apisUsed ?? '')}
                onChange={(e) => update('learning', { apisUsed: e.target.value })}
              />
            )}
          </Field>
          <Field id="externalTemplates" label="External templates or starter code">
            {(aria) => (
              <Input
                {...aria}
                value={String(learning.externalTemplates ?? '')}
                onChange={(e) => update('learning', { externalTemplates: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Section>
    </>
  );
}

function ReviewStep({
  completeness,
  draft,
  update,
  confirmation,
  setConfirmation,
  onSubmit,
  submitting,
  error,
  onGoToStep,
}: {
  completeness: ReturnType<typeof evaluateCompleteness>;
  draft: DraftShape;
  update: (step: string, patch: Record<string, unknown>) => void;
  confirmation: string;
  setConfirmation: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  onGoToStep: (key: string) => void;
}) {
  const declarations = draft.declarations ?? {};
  const incomplete = completeness.steps.filter((s) => !s.complete && s.step !== 'declarations');
  const declarationsComplete =
    completeness.steps.find((s) => s.step === 'declarations')?.complete ?? false;

  return (
    <>
      {/* Missing fields, grouped at the top — the first thing you need to know. */}
      {completeness.totalIssues > 0 && (
        <Alert tone="warning" title="Not ready to submit yet" className="mb-7">
          <p>
            {completeness.totalIssues} item{completeness.totalIssues === 1 ? '' : 's'} still need
            attention. Your work is saved automatically as you fix them.
          </p>
          {incomplete.length > 0 && (
            <ul className="mt-3 space-y-2">
              {incomplete.map((stepSummary) => (
                <li key={stepSummary.step} className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{stepSummary.label}</span>
                  <Badge tone="warning">{stepSummary.issues.length} to fix</Badge>
                  <button
                    type="button"
                    onClick={() => onGoToStep(stepSummary.step)}
                    className="text-sm font-semibold text-brand underline underline-offset-4"
                  >
                    Edit section
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <Section title="Your submission">
        <div className="space-y-3">
          {completeness.steps
            .filter((s) => s.step !== 'declarations')
            .map((stepSummary) => (
              <div
                key={stepSummary.step}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-3 rounded-[10px] border p-4',
                  stepSummary.complete
                    ? 'border-line bg-canvas'
                    : 'border-warning/40 bg-warning-tint',
                )}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{stepSummary.label}</p>
                  {stepSummary.complete ? (
                    <p className="text-sm text-success">Complete</p>
                  ) : (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-warning">
                      {stepSummary.issues.slice(0, 3).map((issue, i) => (
                        <li key={i}>{issue.message}</li>
                      ))}
                      {stepSummary.issues.length > 3 && (
                        <li>…and {stepSummary.issues.length - 3} more.</li>
                      )}
                    </ul>
                  )}
                </div>
                <Button variant="secondary" size="sm" onClick={() => onGoToStep(stepSummary.step)}>
                  Edit section
                </Button>
              </div>
            ))}
        </div>
      </Section>

      <Section title="Declarations" description="All seven are required before you can submit.">
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
      </Section>

      <Section title="Final submission">
        <div className="rounded-[10px] border-2 border-brand-edge bg-brand-tint p-5">
          <h4 className="font-bold text-ink">This locks your submission</h4>
          <p className="mt-1.5 text-sm text-muted">
            After you submit, you will not be able to edit your entry. If something is genuinely
            wrong afterwards, the Outskill team can reopen it for you.
          </p>

          {completeness.complete ? (
            <>
              <div className="mt-5 max-w-sm">
                <Field
                  id="confirmation"
                  label={`Type ${FINAL_SUBMIT_CONFIRMATION} to confirm`}
                  required
                  error={error ?? undefined}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      value={confirmation}
                      autoComplete="off"
                      onChange={(e) => setConfirmation(e.target.value)}
                      placeholder={FINAL_SUBMIT_CONFIRMATION}
                    />
                  )}
                </Field>
              </div>

              <Button
                className="mt-5"
                size="lg"
                loading={submitting}
                disabled={confirmation !== FINAL_SUBMIT_CONFIRMATION}
                onClick={onSubmit}
              >
                Final submit
              </Button>
            </>
          ) : (
            <p className="mt-4 text-sm font-semibold text-warning">
              {declarationsComplete
                ? 'Finish the sections above to unlock final submission.'
                : 'Agree to all seven declarations and finish the sections above to unlock final submission.'}
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
    <p aria-live="polite" className="text-sm text-muted" data-testid="save-status">
      {state === 'saving' && 'Saving…'}
      {state === 'saved' && <span className="text-success">✓ Saved just now</span>}
      {state === 'error' && (
        <span className="text-danger">
          Could not save — {error ?? 'try again'}.{' '}
          <button type="button" onClick={onRetry} className="font-semibold underline">
            Retry
          </button>
        </span>
      )}
      {state === 'idle' && 'Your work saves automatically'}
    </p>
  );
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
    artifacts: {
      deckArtifactId: view.artifacts.find((a) => a.kind === 'deck_pdf')?.id ?? '',
      demoVideoUrl: view.artifacts.find((a) => a.kind === 'demo_video')?.externalUrl ?? '',
      demoUnderThreeMinutes: false,
      ...(stored.artifacts ?? {}),
    },
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
