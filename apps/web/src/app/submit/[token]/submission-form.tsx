'use client';

import * as React from 'react';
import {
  DECLARATION_KEYS,
  DECLARATION_TEXT,
  FINAL_SUBMIT_CONFIRMATION,
  SUBMISSION_STEPS,
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
  Select,
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
 * Drafts autosave on a debounce, so a team never loses work to a closed tab.
 * Validation is shown continuously but never blocks typing — the review screen
 * is where completeness is enforced, and Final Submit is validated again on the
 * server regardless of what the client believes.
 */

const AUTOSAVE_DEBOUNCE_MS = 1200;

type DraftShape = Record<string, Record<string, unknown>>;

interface Props {
  token: string;
  view: ParticipantView;
}

export function SubmissionForm({ token, view }: Props) {
  const [step, setStep] = React.useState<SubmissionStepKey | 'review'>('team');
  const [draft, setDraft] = React.useState<DraftShape>(() => hydrateDraft(view));
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [receipt, setReceipt] = React.useState<string | null>(view.submission.receiptId);

  const readOnly = !view.canEdit;
  const completeness = React.useMemo(() => evaluateCompleteness(draft), [draft]);

  // Debounced autosave. The timer is cleared on unmount so a pending save
  // cannot fire against a stale token after navigation.
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = React.useRef<DraftShape | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const scheduleSave = React.useCallback(
    (next: DraftShape) => {
      if (readOnly) return;
      pendingRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        const payload = pendingRef.current;
        if (!payload) return;
        setSaveState('saving');
        const result = await saveDraftAction(token, payload);
        if (result.ok) {
          setSaveState('saved');
          setSaveError(null);
        } else {
          setSaveState('error');
          setSaveError(result.error ?? 'Could not save.');
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [readOnly, token],
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
      setReceipt(result.receiptId ?? null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setSubmitError(result.error ?? 'Could not submit.');
    }
  };

  if (receipt && readOnly) {
    return null; // The page header already shows the receipt panel.
  }

  const steps = SUBMISSION_STEPS.map((key) => ({
    key,
    label: SUBMISSION_STEP_LABELS[key],
    complete: completeness.steps.find((s) => s.step === key)?.complete ?? false,
  }));

  return (
    <Card>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Stepper
          steps={[...steps, { key: 'review', label: 'Review & submit', complete: completeness.complete }]}
          currentKey={step}
          onSelect={(key) => setStep(key as SubmissionStepKey | 'review')}
        />
        <SaveIndicator state={saveState} error={saveError} readOnly={readOnly} />
      </div>

      {readOnly && (
        <Alert tone="info" className="mb-5">
          {view.submission.status === 'locked'
            ? 'Your submission is locked. Contact the Outskill team if you need it reopened.'
            : 'This cohort is not currently accepting changes.'}
        </Alert>
      )}

      <fieldset disabled={readOnly} className="space-y-6 border-0 p-0">
        {step === 'team' && <TeamStep view={view} draft={draft} update={update} />}
        {step === 'product' && <ProductStep ideas={view.ideas} draft={draft} update={update} />}
        {step === 'live' && <LiveStep view={view} draft={draft} update={update} />}
        {step === 'artifacts' && <ArtifactsStep token={token} view={view} draft={draft} update={update} />}
        {step === 'learning' && <LearningStep draft={draft} update={update} />}
        {step === 'declarations' && <DeclarationsStep draft={draft} update={update} />}
        {step === 'review' && (
          <ReviewStep
            completeness={completeness}
            confirmation={confirmation}
            setConfirmation={setConfirmation}
            onSubmit={onFinalSubmit}
            submitting={submitting}
            error={submitError}
            onGoToStep={(key) => setStep(key)}
          />
        )}
      </fieldset>

      <StepNav step={step} setStep={setStep} />
    </Card>
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

  const setMembers = (next: unknown[]) => update('team', { members: next });

  return (
    <section aria-labelledby="team-heading" className="space-y-5">
      <h2 id="team-heading" className="text-lg font-bold">
        Your team
      </h2>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="groupNumber" label="Group number" required hint="The number Outskill assigned to your team.">
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
          hint="Any format is fine — spaces, hyphens and brackets are all accepted."
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

      <div>
        <h3 className="text-base font-bold">Active team members</h3>
        <p className="mb-3 text-sm text-muted">
          List everyone who actively worked on the product, and what each person did.
        </p>

        <div className="space-y-4">
          {members.map((member, index) => (
            <div key={index} className="rounded-md border border-line p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`member-${index}-name`} label={`Member ${index + 1} name`} required>
                  {(aria) => (
                    <Input
                      {...aria}
                      value={member.fullName ?? ''}
                      onChange={(e) => {
                        const next = [...members];
                        next[index] = { ...member, fullName: e.target.value };
                        setMembers(next);
                      }}
                    />
                  )}
                </Field>
                <Field
                  id={`member-${index}-contribution`}
                  label="What they did"
                  required
                  hint="One line is enough."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      value={member.contribution ?? ''}
                      onChange={(e) => {
                        const next = [...members];
                        next[index] = { ...member, contribution: e.target.value };
                        setMembers(next);
                      }}
                    />
                  )}
                </Field>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 text-danger"
                onClick={() => setMembers(members.filter((_, i) => i !== index))}
              >
                Remove member {index + 1}
              </Button>
            </div>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setMembers([...members, { fullName: '', contribution: '', isActive: true }])}
        >
          Add a team member
        </Button>
      </div>
    </section>
  );
}

function ProductStep({ ideas, draft, update }: StepProps & { ideas: CohortIdea[] }) {
  const product = draft.product ?? {};
  const selectedIdea = ideas.find((i) => i.id === product.ideaId);
  const shouldHave = (product.shouldHaveFeatures as string[]) ?? [];

  return (
    <section aria-labelledby="product-heading" className="space-y-5">
      <h2 id="product-heading" className="text-lg font-bold">
        Your product
      </h2>

      <Field
        id="ideaId"
        label="Approved product idea"
        required
        hint="Choose exactly one. You may only build from the ideas approved for your cohort."
      >
        {(aria) => (
          <Select
            {...aria}
            value={String(product.ideaId ?? '')}
            onChange={(e) => update('product', { ideaId: e.target.value })}
          >
            <option value="">Choose an idea…</option>
            {ideas.map((idea) => (
              <option key={idea.id} value={idea.id}>
                {idea.title}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {selectedIdea && (
        <div className="rounded-md border border-line bg-surface-alt p-4 text-sm">
          <p className="font-semibold">{selectedIdea.title}</p>
          <p className="mt-1 text-muted">{selectedIdea.description}</p>
          <p className="mt-3 font-semibold">A working version should let someone:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {selectedIdea.minimumCoreFlow.map((flow) => (
              <li key={flow}>{flow}</li>
            ))}
          </ul>
        </div>
      )}

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
        hint="“For X, we built Y so they can Z.”"
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
        <Field
          id="differentiation"
          label="How this differs from a basic implementation"
          required
        >
          {(aria) => (
            <Textarea
              {...aria}
              value={String(product.differentiation ?? '')}
              onChange={(e) => update('product', { differentiation: e.target.value })}
            />
          )}
        </Field>
      </div>

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
        <p className="text-sm font-semibold">Should-have features (up to two)</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {[0, 1].map((index) => (
            <Field key={index} id={`shouldHave-${index}`} label={`Should-have ${index + 1}`}>
              {(aria) => (
                <Input
                  {...aria}
                  value={shouldHave[index] ?? ''}
                  onChange={(e) => {
                    const next = [...shouldHave];
                    next[index] = e.target.value;
                    update('product', { shouldHaveFeatures: next.filter((v) => v && v.trim()) });
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
    </section>
  );
}

function LiveStep({ view, draft, update }: StepProps & { view: ParticipantView }) {
  const live = draft.live ?? {};
  const steps = (live.coreTestSteps as { action?: string; expectedResult?: string }[]) ?? [];
  const loginRequired = Boolean(live.loginRequired);

  const setSteps = (next: unknown[]) => update('live', { coreTestSteps: next });

  return (
    <section aria-labelledby="live-heading" className="space-y-5">
      <h2 id="live-heading" className="text-lg font-bold">
        Your live product
      </h2>

      <Field
        id="productUrl"
        label="Live product URL"
        required
        hint="Must start with https:// and be reachable in a browser. Not a Drive folder, not a video link."
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

      <Checkbox
        id="loginRequired"
        label="Our product requires a login"
        description="If it does, you must supply working demo credentials below."
        checked={loginRequired}
        onChange={(e) => update('live', { loginRequired: e.target.checked })}
      />

      {loginRequired && (
        <div className="rounded-md border border-line bg-surface-alt p-4">
          <p className="text-sm font-semibold">Demo credentials</p>
          <p className="mb-3 text-sm text-muted">
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
            <p className="mt-3 text-sm text-brand">✓ Credentials are stored and encrypted.</p>
          )}
        </div>
      )}

      <div>
        <h3 className="text-base font-bold">Core test steps</h3>
        <p className="mb-3 text-sm text-muted">
          Walk us through your must-have flow, step by step, with what should happen each time. At
          least two steps.
        </p>
        <div className="space-y-3">
          {steps.map((entry, index) => (
            <div key={index} className="grid gap-3 rounded-md border border-line p-4 sm:grid-cols-2">
              <Field id={`step-${index}-action`} label={`Step ${index + 1}`} required>
                {(aria) => (
                  <Input
                    {...aria}
                    placeholder="Click “Create trip”"
                    value={entry.action ?? ''}
                    onChange={(e) => {
                      const next = [...steps];
                      next[index] = { ...entry, action: e.target.value };
                      setSteps(next);
                    }}
                  />
                )}
              </Field>
              <Field id={`step-${index}-expected`} label="What should happen" required>
                {(aria) => (
                  <Input
                    {...aria}
                    placeholder="A trip form opens"
                    value={entry.expectedResult ?? ''}
                    onChange={(e) => {
                      const next = [...steps];
                      next[index] = { ...entry, expectedResult: e.target.value };
                      setSteps(next);
                    }}
                  />
                )}
              </Field>
              <div className="sm:col-span-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                >
                  Remove step {index + 1}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setSteps([...steps, { action: '', expectedResult: '' }])}
        >
          Add a step
        </Button>
      </div>

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

      <Field
        id="knownLimitations"
        label="Known limitations"
        required
        hint="Tell us what does not work yet. Being upfront is better than us finding it."
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={String(live.knownLimitations ?? '')}
            onChange={(e) => update('live', { knownLimitations: e.target.value })}
          />
        )}
      </Field>
    </section>
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
    const result = await setDemoVideoAction(token, videoUrl);
    if (!result.ok) setVideoError(result.error ?? 'Could not save the link.');
  };

  return (
    <section aria-labelledby="artifacts-heading" className="space-y-5">
      <h2 id="artifacts-heading" className="text-lg font-bold">
        Deck and demo
      </h2>

      <div className="rounded-md border border-line p-4">
        <p className="text-sm font-semibold">
          Pitch deck (PDF) <span className="text-danger">*</span>
        </p>
        <p className="mb-3 text-sm text-muted">
          Export your deck as a PDF. Maximum 25 MB. This must be a PDF file — a link will not work.
        </p>

        {deck ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="success">Uploaded</Badge>
            <span className="text-sm">{deck.originalFilename}</span>
            <span className="text-sm text-muted">
              {((deck.byteSize ?? 0) / 1024 / 1024).toFixed(1)} MB
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted">No deck uploaded yet.</p>
        )}

        <div className="mt-3">
          <label htmlFor="deck-upload" className="sr-only">
            Choose a PDF pitch deck
          </label>
          <input
            id="deck-upload"
            type="file"
            accept="application/pdf,.pdf"
            className="text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
            }}
          />
          {uploading && <p className="mt-2 text-sm text-muted">Uploading…</p>}
          {uploadError && (
            <p role="alert" className="mt-2 text-sm font-medium text-danger">
              {uploadError}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border border-line p-4">
        <Field
          id="demoVideoUrl"
          label="Demo video link"
          required
          hint="A Loom, YouTube, Drive or Vimeo link to your walkthrough."
          error={videoError ?? undefined}
        >
          {(aria) => (
            <div className="flex gap-2">
              <Input
                {...aria}
                type="url"
                placeholder="https://www.loom.com/share/…"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
              />
              <Button variant="secondary" onClick={onSaveVideo}>
                Save link
              </Button>
            </div>
          )}
        </Field>
        {video?.externalUrl && (
          <p className="mt-2 text-sm text-brand">✓ Saved: {video.externalUrl}</p>
        )}
      </div>

      <Checkbox
        id="demoUnderThreeMinutes"
        label="Our demo video is three minutes or shorter"
        description="Required. Longer videos are not watched in full."
        checked={Boolean(artifacts.demoUnderThreeMinutes)}
        onChange={(e) => update('artifacts', { demoUnderThreeMinutes: e.target.checked })}
      />
    </section>
  );
}

function LearningStep({ draft, update }: StepProps) {
  const learning = draft.learning ?? {};
  const bugs = (learning.bugsFixed as { description?: string; howFixed?: string }[]) ?? [
    {},
    {},
    {},
  ];

  const setBug = (index: number, patch: Record<string, string>) => {
    const next = [...bugs];
    next[index] = { ...next[index], ...patch };
    update('learning', { bugsFixed: next });
  };

  return (
    <section aria-labelledby="learning-heading" className="space-y-5">
      <h2 id="learning-heading" className="text-lg font-bold">
        What you learned
      </h2>
      <p className="text-sm text-muted">
        This comes straight from your workbook — the bug log and the reflection you already filled
        in.
      </p>

      <div>
        <h3 className="text-base font-bold">Three important bugs you found and fixed</h3>
        <div className="mt-3 space-y-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="grid gap-3 rounded-md border border-line p-4 sm:grid-cols-2">
              <Field id={`bug-${index}-description`} label={`Bug ${index + 1}`} required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[index]?.description ?? ''}
                    onChange={(e) => setBug(index, { description: e.target.value })}
                  />
                )}
              </Field>
              <Field id={`bug-${index}-fix`} label="How you fixed it" required>
                {(aria) => (
                  <Textarea
                    {...aria}
                    rows={2}
                    value={bugs[index]?.howFixed ?? ''}
                    onChange={(e) => setBug(index, { howFixed: e.target.value })}
                  />
                )}
              </Field>
            </div>
          ))}
        </div>
      </div>

      {(
        [
          ['deliberatelyExcluded', 'One feature you deliberately excluded', 'And why you parked it.'],
          ['majorTradeoff', 'One major trade-off you made', 'What you gave up, and what you gained.'],
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
    </section>
  );
}

function DeclarationsStep({ draft, update }: StepProps) {
  const declarations = draft.declarations ?? {};
  return (
    <section aria-labelledby="declarations-heading" className="space-y-4">
      <h2 id="declarations-heading" className="text-lg font-bold">
        Declarations
      </h2>
      <p className="text-sm text-muted">All seven are required before you can submit.</p>

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
    </section>
  );
}

function ReviewStep({
  completeness,
  confirmation,
  setConfirmation,
  onSubmit,
  submitting,
  error,
  onGoToStep,
}: {
  completeness: ReturnType<typeof evaluateCompleteness>;
  confirmation: string;
  setConfirmation: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  onGoToStep: (key: SubmissionStepKey) => void;
}) {
  return (
    <section aria-labelledby="review-heading" className="space-y-5">
      <h2 id="review-heading" className="text-lg font-bold">
        Review and submit
      </h2>

      <div className="space-y-3">
        {completeness.steps.map((step) => (
          <div
            key={step.step}
            className={cn(
              'rounded-md border p-4',
              step.complete ? 'border-line' : 'border-danger bg-danger-tint',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                {step.label}{' '}
                {step.complete ? (
                  <Badge tone="success">Complete</Badge>
                ) : (
                  <Badge tone="danger">
                    {step.issues.length} item{step.issues.length === 1 ? '' : 's'} to fix
                  </Badge>
                )}
              </p>
              {!step.complete && (
                <Button variant="secondary" size="sm" onClick={() => onGoToStep(step.step)}>
                  Go to {step.label}
                </Button>
              )}
            </div>
            {!step.complete && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-danger">
                {step.issues.slice(0, 6).map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
                {step.issues.length > 6 && <li>…and {step.issues.length - 6} more.</li>}
              </ul>
            )}
          </div>
        ))}
      </div>

      {completeness.complete ? (
        <div className="rounded-md border-2 border-ink p-5">
          <h3 className="text-base font-bold">Final submit</h3>
          <p className="mt-1 text-sm text-muted">
            Submitting locks your submission. You will not be able to edit it afterwards without
            asking the Outskill team to reopen it.
          </p>

          <div className="mt-4 max-w-sm">
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
            className="mt-4"
            size="lg"
            loading={submitting}
            disabled={confirmation !== FINAL_SUBMIT_CONFIRMATION}
            onClick={onSubmit}
          >
            Final submit
          </Button>
        </div>
      ) : (
        <Alert tone="warning" title="Not ready to submit yet">
          Fix the {completeness.totalIssues} outstanding item
          {completeness.totalIssues === 1 ? '' : 's'} above. Your work is saved automatically as you
          go.
        </Alert>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------
// Chrome
// --------------------------------------------------------------------------

function StepNav({
  step,
  setStep,
}: {
  step: SubmissionStepKey | 'review';
  setStep: (key: SubmissionStepKey | 'review') => void;
}) {
  const order: (SubmissionStepKey | 'review')[] = [...SUBMISSION_STEPS, 'review'];
  const index = order.indexOf(step);
  const previous = index > 0 ? order[index - 1] : null;
  const next = index < order.length - 1 ? order[index + 1] : null;

  const label = (key: SubmissionStepKey | 'review') =>
    key === 'review' ? 'Review & submit' : SUBMISSION_STEP_LABELS[key];

  return (
    <div className="mt-6 flex justify-between border-t border-line pt-4">
      {previous ? (
        <Button variant="secondary" onClick={() => setStep(previous)}>
          ← {label(previous)}
        </Button>
      ) : (
        <span />
      )}
      {next && <Button onClick={() => setStep(next)}>{label(next)} →</Button>}
    </div>
  );
}

function SaveIndicator({
  state,
  error,
  readOnly,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  error: string | null;
  readOnly: boolean;
}) {
  if (readOnly) return null;
  return (
    <p aria-live="polite" className="text-sm text-muted">
      {state === 'saving' && 'Saving…'}
      {state === 'saved' && <span className="text-brand">✓ Draft saved</span>}
      {state === 'error' && <span className="text-danger">{error ?? 'Could not save'}</span>}
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
      // Credential values are never sent to the client — only whether they exist.
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
