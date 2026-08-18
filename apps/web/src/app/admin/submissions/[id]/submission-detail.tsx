'use client';

import * as React from 'react';
import {
  DECLARATION_KEYS,
  DECLARATION_TEXT,
  DISQUALIFICATION_DEFINITIONS,
  RUBRIC_CATEGORIES,
  type AdminSubmissionDetail,
} from '@ohj/shared/client';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  Tabs,
  Button,
} from '@/components/ui';
import { AdminForm } from '@/components/admin-form';
import {
  confirmDisqualificationAction,
  overrideScoreAction,
  proposeDisqualificationAction,
  reopenSubmissionAction,
  rerunAssessmentAction,
  resolveManualReviewAction,
  revealCredentialsAction,
  reverseDisqualificationAction,
  setLateExceptionAction,
} from '@/server/admin-actions';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'team', label: 'Team' },
  { key: 'declaration', label: 'Declaration' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'preflight', label: 'Preflight' },
  { key: 'testplan', label: 'Test plan' },
  { key: 'evidence', label: 'Browser evidence' },
  { key: 'scores', label: 'Scores' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'review', label: 'Manual review' },
  { key: 'audit', label: 'Audit history' },
] as const;

export function SubmissionDetail({
  detail,
  csrfToken,
}: {
  detail: AdminSubmissionDetail;
  csrfToken: string;
}) {
  const [tab, setTab] = React.useState<string>('overview');

  const flagCount =
    detail.manualReviewFlags.filter((f) => f.status === 'open').length +
    detail.disqualifications.filter((d) => d.status === 'proposed').length;

  const tabs = TABS.map((t) => ({
    ...t,
    badge:
      t.key === 'review' && flagCount > 0 ? (
        <Badge tone="warning">{flagCount}</Badge>
      ) : undefined,
  }));

  return (
    <Tabs tabs={tabs} activeKey={tab} onChange={setTab}>
      {tab === 'overview' && <OverviewTab detail={detail} csrfToken={csrfToken} />}
      {tab === 'team' && <TeamTab detail={detail} csrfToken={csrfToken} />}
      {tab === 'declaration' && <DeclarationTab detail={detail} csrfToken={csrfToken} />}
      {tab === 'artifacts' && <ArtifactsTab detail={detail} />}
      {tab === 'preflight' && <PreflightTab detail={detail} />}
      {tab === 'testplan' && <TestPlanTab detail={detail} />}
      {tab === 'evidence' && <EvidenceTab detail={detail} />}
      {tab === 'scores' && <ScoresTab detail={detail} csrfToken={csrfToken} />}
      {tab === 'feedback' && <FeedbackTab detail={detail} />}
      {tab === 'review' && <ReviewTab detail={detail} csrfToken={csrfToken} />}
      {tab === 'audit' && <AuditTab detail={detail} />}
    </Tabs>
  );
}

// --------------------------------------------------------------------------

function OverviewTab({ detail, csrfToken }: { detail: AdminSubmissionDetail; csrfToken: string }) {
  const s = detail.submission;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Product" />
        <DescriptionList
          items={[
            { term: 'Product', description: s.productName ?? '—' },
            { term: 'Idea', description: detail.idea?.title ?? '—' },
            { term: 'Primary user', description: s.primaryUser ?? '—' },
            { term: 'Problem', description: s.exactProblem ?? '—' },
            { term: 'Promise', description: s.oneSentencePromise ?? '—' },
            { term: 'Description', description: s.briefDescription ?? '—' },
            { term: 'Why AI', description: s.whyAiNecessary ?? '—' },
            { term: 'Differentiation', description: s.differentiation ?? '—' },
            { term: 'Must-have workflow', description: s.mustHaveWorkflow ?? '—' },
            {
              term: 'Should-haves',
              description: s.shouldHaveFeatures.length ? s.shouldHaveFeatures.join('; ') : '—',
            },
            { term: 'Excluded', description: s.excludedFeatures ?? '—' },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Live product" />
        <DescriptionList
          items={[
            {
              term: 'URL',
              description: s.productUrl ? (
                <a href={s.productUrl} rel="noreferrer noopener nofollow" className="text-brand-text underline">
                  {s.productUrl}
                </a>
              ) : (
                '—'
              ),
            },
            { term: 'Login required', description: s.loginRequired ? 'Yes' : 'No' },
            { term: 'Sample inputs', description: s.safeSampleInputs ?? '—' },
            { term: 'Reset instructions', description: s.resetInstructions ?? '—' },
            { term: 'Known limitations', description: s.knownLimitations ?? '—' },
          ]}
        />

        {s.coreTestSteps.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-bold">Team-declared test steps</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              {s.coreTestSteps.map((step, i) => (
                <li key={i}>
                  {step.action} → <span className="text-muted">{step.expectedResult}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {s.loginRequired && <CredentialsPanel submissionId={s.id} />}
      </Card>

      <Card>
        <CardHeader title="Learning evidence" />
        <DescriptionList
          items={[
            {
              term: 'Bugs fixed',
              description:
                s.bugsFixed.length > 0 ? (
                  <ol className="list-decimal space-y-1 pl-4">
                    {s.bugsFixed.map((bug, i) => (
                      <li key={i}>
                        {bug.description} <span className="text-muted">— {bug.howFixed}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  '—'
                ),
            },
            { term: 'Trade-off', description: s.majorTradeoff ?? '—' },
            { term: 'Day 12 → 13', description: s.day12ToDay13Changes ?? '—' },
            { term: 'Learning', description: s.mostImportantLearning ?? '—' },
            { term: 'Next 7 days', description: s.nextSevenDayPlan ?? '—' },
            { term: 'Stack', description: s.builderStack ?? '—' },
            { term: 'APIs', description: s.apisUsed ?? '—' },
            { term: 'External templates', description: s.externalTemplates ?? '—' },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Admin actions" />
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-bold">Reopen for editing</h3>
            <p className="mb-2 text-sm text-muted">
              The team sees your reason. Reopening is audit-logged.
            </p>
            <AdminForm
              action={reopenSubmissionAction}
              csrfToken={csrfToken}
              submitLabel="Reopen submission"
              submitVariant="secondary"
            >
              <input type="hidden" name="submissionId" value={s.id} />
              <Field id="reopen-reason" label="Reason" required>
                {(aria) => <Textarea {...aria} name="reason" rows={2} />}
              </Field>
            </AdminForm>
          </div>

          <div>
            <h3 className="text-sm font-bold">Re-run assessment</h3>
            <p className="mb-2 text-sm text-muted">
              Puts this submission back in the queue from the start.
            </p>
            <AdminForm
              action={rerunAssessmentAction}
              csrfToken={csrfToken}
              submitLabel="Re-queue"
              submitVariant="secondary"
              confirm="Re-run the full assessment for this submission?"
            >
              <input type="hidden" name="submissionId" value={s.id} />
            </AdminForm>
          </div>
        </div>

        {s.isLate && (
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="text-sm font-bold">Late submission</h3>
            <p className="mb-2 text-sm text-muted">
              Lateness is a recorded fact. Whether it disqualifies is your decision, and it is
              reversible.
            </p>
            <AdminForm
              action={setLateExceptionAction}
              csrfToken={csrfToken}
              submitLabel={s.hasLateException ? 'Revoke exception' : 'Grant exception'}
              submitVariant="secondary"
            >
              <input type="hidden" name="submissionId" value={s.id} />
              <input type="hidden" name="granted" value={s.hasLateException ? 'false' : 'true'} />
              <Field id="late-reason" label="Reason" required>
                {(aria) => <Input {...aria} name="reason" />}
              </Field>
            </AdminForm>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Credentials are masked until an explicit reveal, and every reveal is audited.
 * They belong to a third party — the bar for showing them is deliberately high.
 */
function CredentialsPanel({ submissionId }: { submissionId: string }) {
  const [revealed, setRevealed] = React.useState<{
    username?: string;
    password?: string;
    loginInstructions?: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onReveal = async () => {
    setPending(true);
    setError(null);
    const result = await revealCredentialsAction(submissionId);
    setPending(false);
    if (result.ok) setRevealed(result);
    else setError(result.error ?? 'Could not reveal.');
  };

  return (
    <div className="mt-4 rounded-md border border-line bg-surface-alt p-4">
      <h3 className="text-sm font-bold">Demo credentials</h3>
      <p className="mb-3 text-sm text-muted">
        Encrypted at rest and never sent to an AI model. Revealing is logged.
      </p>

      {revealed ? (
        <dl className="space-y-1 font-mono text-sm">
          <div>
            <dt className="inline font-semibold">Username: </dt>
            <dd className="inline">{revealed.username}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Password: </dt>
            <dd className="inline">{revealed.password}</dd>
          </div>
          {revealed.loginInstructions && (
            <div className="font-sans">
              <dt className="inline font-semibold">Instructions: </dt>
              <dd className="inline">{revealed.loginInstructions}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="font-mono text-sm">•••••••••••• / ••••••••••••</p>
      )}

      {!revealed && (
        <Button variant="secondary" size="sm" className="mt-3" loading={pending} onClick={onReveal}>
          Reveal credentials
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamTab({ detail }: { detail: AdminSubmissionDetail; csrfToken: string }) {
  return (
    <Card>
      <CardHeader title="Team" />
      <DescriptionList
        items={[
          { term: 'Group', description: String(detail.team.groupNumber) },
          { term: 'Lead', description: detail.team.leadName },
          { term: 'Email', description: detail.team.leadEmail },
          { term: 'Phone', description: detail.team.leadPhone },
          { term: 'Receipt', description: detail.submission.receiptId ?? '—' },
        ]}
      />
      <h3 className="mt-5 text-sm font-bold">Members</h3>
      <Table caption="Team members and contributions">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Contribution</Th>
          </tr>
        </thead>
        <tbody>
          {detail.members.map((member) => (
            <tr key={member.id}>
              <Td>{member.fullName}</Td>
              <Td className="text-muted">{member.contribution}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function DeclarationTab({ detail }: { detail: AdminSubmissionDetail; csrfToken: string }) {
  const declarations = detail.declarations;
  if (!declarations) return <EmptyState title="No declarations recorded" />;

  return (
    <Card>
      <CardHeader
        title="Declarations"
        description={
          declarations.acceptedAt
            ? `Accepted ${new Date(declarations.acceptedAt).toLocaleString()}`
            : 'Not yet accepted'
        }
      />
      <ul className="space-y-3">
        {DECLARATION_KEYS.map((key) => (
          <li key={key} className="flex gap-3">
            <Badge tone={declarations[key] ? 'success' : 'danger'}>
              {declarations[key] ? 'yes' : 'no'}
            </Badge>
            <span className="text-sm">{DECLARATION_TEXT[key]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ArtifactsTab({ detail }: { detail: AdminSubmissionDetail }) {
  const analysis = detail.artifactAnalysis;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Submitted artifacts" />
        {detail.artifacts.length === 0 ? (
          <p className="text-sm text-muted">No artifacts.</p>
        ) : (
          <Table caption="Artifacts">
            <thead>
              <tr>
                <Th>Kind</Th>
                <Th>Reference</Th>
                <Th>Size</Th>
                <Th>Accessible</Th>
              </tr>
            </thead>
            <tbody>
              {detail.artifacts.map((artifact) => (
                <tr key={artifact.id}>
                  <Td>{artifact.kind.replace(/_/g, ' ')}</Td>
                  <Td className="break-all">
                    {artifact.externalUrl ? (
                      <a
                        href={artifact.externalUrl}
                        rel="noreferrer noopener nofollow"
                        className="text-brand-text underline"
                      >
                        {artifact.externalUrl}
                      </a>
                    ) : artifact.kind === 'deck_pdf' ? (
                      // The bucket is private, so the deck is reachable only
                      // through a short-lived signed URL minted per request.
                      // Showing the storage path alone left a reviewer with a
                      // file they could see the existence of and not read.
                      <div className="flex flex-wrap items-center gap-3">
                        <a
                          href={`/api/admin/submissions/${detail.submission.id}/deck`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-brand-text underline"
                        >
                          View deck
                        </a>
                        <a
                          href={`/api/admin/submissions/${detail.submission.id}/deck?download=1`}
                          className="font-semibold text-brand-text underline"
                        >
                          Download deck
                        </a>
                        <span className="font-mono text-xs text-muted">
                          {artifact.originalFilename ?? artifact.storagePath}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono text-xs">{artifact.storagePath}</span>
                    )}
                  </Td>
                  <Td>{artifact.byteSize ? `${(artifact.byteSize / 1024 / 1024).toFixed(1)} MB` : '—'}</Td>
                  <Td>
                    {artifact.isAccessible === null ? (
                      <Badge tone="neutral">unchecked</Badge>
                    ) : artifact.isAccessible ? (
                      <Badge tone="success">yes</Badge>
                    ) : (
                      <Badge tone="danger">no</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {analysis && (
        <Card>
          <CardHeader
            title="Artifact analysis"
            description={`Model ${analysis.modelVersion} · prompt ${analysis.promptVersion}`}
          />
          <DescriptionList
            items={[
              { term: 'Deck pages', description: String(analysis.deckPageCount ?? '—') },
              { term: 'Deck text extracted', description: analysis.deckTextExtracted ? 'Yes' : 'No' },
              { term: 'Transcript', description: analysis.transcriptAvailable ? 'Provided' : 'None' },
            ]}
          />

          {analysis.videoAnalysisLimited && (
            <Alert tone="warning" title="Video could not be analysed" className="mt-4">
              {analysis.videoLimitationReason}
            </Alert>
          )}

          {analysis.injectionFlags.length > 0 && (
            <Alert tone="warning" title="Prompt-injection patterns detected" className="mt-4">
              <p>
                Instruction-like content was found inside participant material. It was treated as
                data and never followed. This is a review flag, not a disqualification ground.
              </p>
              <ul className="mt-2 list-disc pl-5">
                {analysis.injectionFlags.map((flag, i) => (
                  <li key={i}>
                    <strong>{flag.source}</strong> ({flag.severity}) — {flag.pattern}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </Card>
      )}
    </div>
  );
}

function PreflightTab({ detail }: { detail: AdminSubmissionDetail }) {
  if (detail.preflight.length === 0) return <EmptyState title="Preflight has not run yet" />;

  return (
    <Card>
      <CardHeader
        title="Preflight checks"
        description="Every attempt is recorded, not just the last one — that is what lets a temporary outage be told apart from a genuinely absent product."
      />
      <Table caption="Preflight check results">
        <thead>
          <tr>
            <Th>Check</Th>
            <Th>Attempt</Th>
            <Th>Result</Th>
            <Th>Failure class</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          {detail.preflight.map((check) => (
            <tr key={check.id}>
              <Td className="font-medium">{check.checkKey.replace(/_/g, ' ')}</Td>
              <Td className="font-mono">{check.attemptNumber}</Td>
              <Td>
                <Badge
                  tone={
                    check.status === 'pass'
                      ? 'success'
                      : check.status === 'fail'
                        ? 'danger'
                        : check.status === 'warn'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {check.status}
                </Badge>
              </Td>
              <Td className="text-muted">{check.failureClass === 'none' ? '—' : check.failureClass}</Td>
              <Td className="text-muted">{String((check.detail as { message?: string }).message ?? '')}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function TestPlanTab({ detail }: { detail: AdminSubmissionDetail }) {
  const plan = detail.testPlan;
  if (!plan) {
    return (
      <EmptyState
        title="No test plan generated"
        description="A plan is generated once preflight and artifact analysis have completed."
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Generated test plan"
        description={`${plan.stepCount} steps · model ${plan.modelVersion} · prompt ${plan.promptVersion} · ${plan.validationStatus}`}
      />
      {plan.summary && <p className="mb-4 text-sm text-muted">{plan.summary}</p>}

      {plan.rejectedSteps.length > 0 && (
        <Alert tone="warning" title={`${plan.rejectedSteps.length} step(s) rejected`} className="mb-4">
          <p>
            These failed DSL validation and were dropped. A step outside the permitted action set
            cannot be stored or executed.
          </p>
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {plan.rejectedSteps.map((step, i) => (
              <li key={i}>
                #{step.index}: {step.reason}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Table caption="Test plan steps">
        <thead>
          <tr>
            <Th className="w-12">#</Th>
            <Th>Action</Th>
            <Th>Detail</Th>
            <Th>Why</Th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.map((step) => (
            <tr key={step.id}>
              <Td className="font-mono">{step.stepIndex + 1}</Td>
              <Td>
                <Badge tone={step.isCleanup ? 'neutral' : 'info'}>{step.step.action}</Badge>
              </Td>
              <Td className="font-mono text-xs">{JSON.stringify(step.step)}</Td>
              <Td className="text-muted">{step.rationale ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function EvidenceTab({ detail }: { detail: AdminSubmissionDetail }) {
  if (detail.browserRuns.length === 0) {
    return <EmptyState title="No browser runs recorded" />;
  }

  return (
    <div className="space-y-6">
      {detail.browserRuns.map((run) => (
        <Card key={run.id}>
          <CardHeader
            title={`${run.viewport} run`}
            description={`${((run.durationMs ?? 0) / 1000).toFixed(1)}s · ${run.browserVersion ?? 'unknown browser'}`}
            actions={
              <Badge
                tone={run.status === 'passed' ? 'success' : run.status === 'partial' ? 'warning' : 'danger'}
              >
                {run.status}
              </Badge>
            }
            level={3}
          />

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Console errors" value={run.consoleErrorCount} warn={run.consoleErrorCount > 0} />
            <Metric label="Failed requests" value={run.networkFailureCount} warn={run.networkFailureCount > 0} />
            <Metric label="Accessibility issues" value={run.a11yViolationCount} warn={run.a11yViolationCount > 0} />
            <Metric label="Timed out" value={run.timedOut ? 'yes' : 'no'} warn={run.timedOut} />
            <Metric label="Cleanup" value={run.cleanupStatus} warn={run.cleanupStatus !== 'complete'} />
          </div>

          {run.timedOut && (
            <Alert tone="warning" className="mb-4">
              This run hit its time budget. Anything after the last completed step was never
              exercised, so treat missing evidence as unknown rather than absent.
            </Alert>
          )}

          <Table caption={`${run.viewport} run steps`}>
            <thead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Action</Th>
                <Th>Result</Th>
                <Th className="text-right">Time</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((step) => (
                <tr key={step.id}>
                  <Td className="font-mono">{step.stepIndex + 1}</Td>
                  <Td>{step.action}</Td>
                  <Td>
                    <Badge
                      tone={
                        step.status === 'passed'
                          ? 'success'
                          : step.status === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {step.status}
                    </Badge>
                  </Td>
                  <Td className="text-right font-mono text-xs">{step.durationMs}ms</Td>
                  <Td className="text-muted">
                    {String((step.assertionDetail as { detail?: string }).detail ?? '')}
                    {step.screenshotPath && (
                      <span className="ml-2 font-mono text-xs text-info">📷 {step.screenshotPath}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          {run.tracePath && (
            <p className="mt-3 font-mono text-xs text-muted">Trace: {run.tracePath}</p>
          )}
        </Card>
      ))}
    </div>
  );
}

function ScoresTab({ detail, csrfToken }: { detail: AdminSubmissionDetail; csrfToken: string }) {
  if (detail.scores.length === 0) return <EmptyState title="Not scored yet" />;

  const summary = detail.summary;

  return (
    <div className="space-y-6">
      {summary && (
        <Card>
          <CardHeader
            title={`Total ${summary.totalScore.toFixed(2)} / 100`}
            description={`Mean confidence ${summary.meanConfidence.toFixed(2)} · lowest ${summary.minConfidence.toFixed(2)} · model ${summary.modelVersion} · prompt ${summary.promptVersion}`}
            actions={summary.lowConfidence ? <Badge tone="warning">low confidence</Badge> : undefined}
          />
          {summary.risks.length > 0 && (
            <Alert tone="warning" title="Unresolved risks">
              <ul className="list-disc pl-5">
                {summary.risks.map((risk, i) => (
                  <li key={i}>{risk}</li>
                ))}
              </ul>
            </Alert>
          )}
          {detail.consistencyReviews.length > 0 && (
            <div className="mt-4 text-sm">
              <h3 className="font-bold">Consistency review</h3>
              {detail.consistencyReviews.map((review) => (
                <p key={review.id} className="text-muted">
                  Pass {review.passNumber} ({review.triggerReason.join(', ')}) — delta{' '}
                  {review.scoreDelta.toFixed(2)}, {review.adjusted ? 'adjusted' : 'no adjustment'}.
                </p>
              ))}
            </div>
          )}
        </Card>
      )}

      {RUBRIC_CATEGORIES.map((category) => {
        const score = detail.scores.find((s) => s.categoryKey === category.key);
        if (!score) return null;
        const hasEvidence =
          score.supportingEvidence.length + score.contradictoryEvidence.length + score.missingEvidence.length > 0;

        return (
          <Card key={category.key}>
            <CardHeader
              title={`${category.title} — ${score.rawScore} / ${score.maxPoints}`}
              description={score.rationale}
              level={3}
              actions={
                <div className="flex gap-2">
                  <Badge tone={score.confidence < 0.6 ? 'warning' : 'neutral'}>
                    confidence {score.confidence.toFixed(2)}
                  </Badge>
                  {score.isOverridden && <Badge tone="info">overridden</Badge>}
                </div>
              }
            />

            {!hasEvidence && (
              <Alert tone="danger" className="mb-3">
                This score carries no evidence. Treat it as unsupported.
              </Alert>
            )}

            <div className="grid gap-4 md:grid-cols-3">
              <EvidenceList title="Supporting" tone="success" items={score.supportingEvidence} />
              <EvidenceList title="Contradictory" tone="danger" items={score.contradictoryEvidence} />
              <EvidenceList title="Missing" tone="warning" items={score.missingEvidence} />
            </div>

            {score.isOverridden && (
              <Alert tone="info" className="mt-4">
                Overridden from {score.originalRawScore} to {score.rawScore} by {score.overriddenBy}.
                Reason: {score.overrideReason}
              </Alert>
            )}

            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">Override this score</summary>
              <div className="mt-3 rounded-md border border-line p-4">
                <AdminForm
                  action={overrideScoreAction}
                  csrfToken={csrfToken}
                  submitLabel="Override"
                  submitVariant="secondary"
                >
                  <input type="hidden" name="submissionId" value={detail.submission.id} />
                  <input type="hidden" name="jobId" value={detail.job?.id ?? ''} />
                  <input type="hidden" name="categoryKey" value={category.key} />
                  <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                    <Field id={`override-${category.key}`} label={`Score / ${category.maxPoints}`} required>
                      {(aria) => (
                        <Input
                          {...aria}
                          name="rawScore"
                          type="number"
                          step="0.25"
                          min={0}
                          max={category.maxPoints}
                          defaultValue={score.rawScore}
                        />
                      )}
                    </Field>
                    <Field
                      id={`override-reason-${category.key}`}
                      label="Reason"
                      required
                      hint="Recorded permanently alongside the machine's original score."
                    >
                      {(aria) => <Textarea {...aria} name="reason" rows={2} />}
                    </Field>
                  </div>
                </AdminForm>
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}

function EvidenceList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'success' | 'danger' | 'warning';
  items: string[];
}) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-bold">
        <Badge tone={tone}>{title}</Badge>
      </h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted">None recorded.</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedbackTab({ detail }: { detail: AdminSubmissionDetail }) {
  const report = detail.feedbackReport;
  if (!report) return <EmptyState title="No feedback report generated yet" />;

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Not visible to participants">
        Feedback reports are generated and stored, but Version 1 exposes them to nobody outside this
        dashboard. Sharing them is a future product decision.
      </Alert>

      <Card>
        <CardHeader title="Participant feedback report" description={report.productSummary} />

        <h3 className="text-sm font-bold">Strengths</h3>
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
          {report.strengths.map((strength, i) => (
            <li key={i}>{strength}</li>
          ))}
        </ul>

        <h3 className="text-sm font-bold">Priority improvements</h3>
        <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm">
          {report.improvements.map((improvement, i) => (
            <li key={i}>
              <strong>{improvement.title}</strong>
              <p className="text-muted">{improvement.detail}</p>
            </li>
          ))}
        </ol>

        {report.bugs.length > 0 && (
          <>
            <h3 className="text-sm font-bold">Bugs observed</h3>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
              {report.bugs.map((bug, i) => (
                <li key={i}>
                  {bug.description} <span className="text-muted">— {bug.evidence}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="text-sm font-bold">Suggested next seven days</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {report.nextSevenDayPlan.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function ReviewTab({ detail, csrfToken }: { detail: AdminSubmissionDetail; csrfToken: string }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Manual review flags" />
        {detail.manualReviewFlags.length === 0 ? (
          <p className="text-sm text-muted">No flags raised.</p>
        ) : (
          <div className="space-y-4">
            {detail.manualReviewFlags.map((flag) => (
              <div key={flag.id} className="rounded-md border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{flag.reasonCode.replace(/_/g, ' ')}</p>
                  <Badge tone={flag.status === 'open' ? 'warning' : 'neutral'}>{flag.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{flag.detail}</p>
                {flag.resolutionNote && (
                  <p className="mt-2 text-sm">
                    <strong>Resolution:</strong> {flag.resolutionNote}
                  </p>
                )}

                {flag.status === 'open' && (
                  <div className="mt-3 border-t border-line pt-3">
                    <AdminForm
                      action={resolveManualReviewAction}
                      csrfToken={csrfToken}
                      submitLabel="Record decision"
                      submitVariant="secondary"
                    >
                      <input type="hidden" name="flagId" value={flag.id} />
                      <input type="hidden" name="submissionId" value={detail.submission.id} />
                      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                        <Field id={`status-${flag.id}`} label="Outcome">
                          {(aria) => (
                            <Select {...aria} name="status" defaultValue="resolved">
                              <option value="resolved">Resolved</option>
                              <option value="dismissed">Dismissed</option>
                            </Select>
                          )}
                        </Field>
                        <Field id={`note-${flag.id}`} label="What you concluded" required>
                          {(aria) => <Textarea {...aria} name="note" rows={2} />}
                        </Field>
                      </div>
                    </AdminForm>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Disqualification"
          description="Only the eleven permitted grounds can be recorded. Weak UI, a low score, ordinary bugs and AI suspicion are not among them."
        />

        {detail.disqualifications.length > 0 && (
          <div className="mb-5 space-y-4">
            {detail.disqualifications.map((dq) => (
              <div
                key={dq.id}
                className={`rounded-md border-l-4 p-4 ${
                  dq.status === 'confirmed'
                    ? 'border-danger bg-danger-tint'
                    : dq.status === 'reversed'
                      ? 'border-line bg-surface-alt'
                      : 'border-warning bg-warning-tint'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{dq.reasonCode.replace(/_/g, ' ')}</p>
                  <Badge
                    tone={dq.status === 'confirmed' ? 'danger' : dq.status === 'reversed' ? 'neutral' : 'warning'}
                  >
                    {dq.status}
                  </Badge>
                </div>
                <p className="mt-1 text-sm">{dq.reasonDetail}</p>
                <p className="mt-1 text-xs text-muted">Proposed by {dq.proposedBy}</p>
                {dq.reversedReason && (
                  <p className="mt-2 text-sm">
                    <strong>Reversed:</strong> {dq.reversedReason}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-4 border-t border-line pt-3">
                  {dq.status === 'proposed' && (
                    <AdminForm
                      action={confirmDisqualificationAction}
                      csrfToken={csrfToken}
                      submitLabel="Confirm disqualification"
                      submitVariant="danger"
                      confirm="Confirm this disqualification? It removes the team from the ranking. It is reversible and logged."
                    >
                      <input type="hidden" name="disqualificationId" value={dq.id} />
                      <input type="hidden" name="submissionId" value={detail.submission.id} />
                    </AdminForm>
                  )}
                  {dq.status !== 'reversed' && (
                    <AdminForm
                      action={reverseDisqualificationAction}
                      csrfToken={csrfToken}
                      submitLabel="Reverse"
                      submitVariant="secondary"
                    >
                      <input type="hidden" name="disqualificationId" value={dq.id} />
                      <input type="hidden" name="submissionId" value={detail.submission.id} />
                      <Field id={`reverse-${dq.id}`} label="Reason for reversing" required>
                        {(aria) => <Input {...aria} name="reason" />}
                      </Field>
                    </AdminForm>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-sm font-semibold">Propose a disqualification</summary>
          <div className="mt-3 rounded-md border border-line p-4">
            <AdminForm
              action={proposeDisqualificationAction}
              csrfToken={csrfToken}
              submitLabel="Propose"
              submitVariant="secondary"
            >
              <input type="hidden" name="submissionId" value={detail.submission.id} />
              <Field id="dq-reason-code" label="Ground" required>
                {(aria) => (
                  <Select {...aria} name="reasonCode">
                    {DISQUALIFICATION_DEFINITIONS.map((definition) => (
                      <option key={definition.code} value={definition.code}>
                        {definition.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="mt-4">
                <Field id="dq-detail" label="Evidence" required hint="What did you verify, and how?">
                  {(aria) => <Textarea {...aria} name="reasonDetail" rows={3} />}
                </Field>
              </div>
            </AdminForm>
          </div>
        </details>
      </Card>
    </div>
  );
}

function AuditTab({ detail }: { detail: AdminSubmissionDetail }) {
  const entries = [
    ...detail.events.map((event) => ({
      at: event.createdAt,
      actor: event.actorType,
      action: event.eventType,
      detail: JSON.stringify(event.detail),
    })),
    ...detail.auditLogs.map((log) => ({
      at: log.createdAt,
      actor: log.actorType,
      action: log.action,
      detail: JSON.stringify(log.after ?? {}),
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (entries.length === 0) return <EmptyState title="No history recorded" />;

  return (
    <Card>
      <CardHeader
        title="History"
        description="Shared admin actions are recorded as shared-admin and cannot be attributed to an individual person."
      />
      <Table caption="Submission history">
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i}>
              <Td className="whitespace-nowrap">{new Date(entry.at).toLocaleString()}</Td>
              <Td>
                <Badge tone="neutral">{entry.actor}</Badge>
              </Td>
              <Td className="font-medium">{entry.action.replace(/[._]/g, ' ')}</Td>
              <Td className="font-mono text-xs text-muted">{entry.detail}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Metric({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${warn ? 'border-warning bg-warning-tint' : 'border-line'}`}>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
