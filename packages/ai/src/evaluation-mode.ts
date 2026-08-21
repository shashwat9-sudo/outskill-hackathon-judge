/**
 * What the external model is allowed to see.
 *
 * The product is being evaluated internally on a free AI tier. Free tiers are
 * where a provider's data-retention and training terms are least favourable —
 * several reserve the right to use free-tier traffic for model improvement —
 * and a learner's pitch deck should not be the thing that discovers this.
 *
 * So `synthetic_only` is the default, and it is a refusal rather than a
 * warning. An operator under deadline pressure who sees "are you sure?" clicks
 * yes; an operator who sees "this cohort holds real learner work and the
 * current mode forbids sending it" goes and changes the setting deliberately,
 * which is the whole point.
 *
 * Nothing here inspects submission content. The decision is made from the
 * cohort and submission a job belongs to, so it cannot be defeated by a
 * participant writing something that looks synthetic.
 */

export type EvaluationMode = 'synthetic_only' | 'production';

/**
 * What a job is about to send.
 *
 * `isDemoCohort` and `isSyntheticSubmission` come from the store, not from
 * anything a participant controls.
 */
export interface DispatchSubject {
  /** The cohort's own marker: demo fixtures, or a cohort created for testing. */
  isDemoCohort: boolean;
  /** A submission created by fixtures or a seeded acceptance test. */
  isSyntheticSubmission: boolean;
  /** For the message an operator reads. Never sent to a provider. */
  cohortName: string;
  /** Anonymised. Never a team identifier. */
  correlationId: string;
}

export type DispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: string; operatorAction: string };

/**
 * May this reach an external provider?
 *
 * Both conditions have to hold in `synthetic_only`: a synthetic submission
 * inside a real cohort is still sitting in a database full of real ones, and a
 * demo cohort containing a genuine submission is a mistake worth catching.
 */
export function canDispatchToProvider(
  mode: EvaluationMode,
  subject: DispatchSubject,
): DispatchDecision {
  if (mode === 'production') return { allowed: true };

  if (subject.isDemoCohort && subject.isSyntheticSubmission) return { allowed: true };

  const what = !subject.isDemoCohort
    ? `"${subject.cohortName}" is a real cohort`
    : 'this submission is real learner work';

  return {
    allowed: false,
    reason:
      `Refused: ${what}, and AI_EVALUATION_MODE is "synthetic_only". ` +
      'Nothing was sent to the AI provider.',
    operatorAction:
      'This mode exists because the free AI tier is being used for internal evaluation, ' +
      'and free-tier terms are the least protective of submitted content. ' +
      'To judge a real cohort, set AI_EVALUATION_MODE=production — and check the ' +
      "provider's data-retention terms for the key you are using first.",
  };
}

/** Raised instead of dispatching. Carries what the operator needs to decide. */
export class EvaluationModeError extends Error {
  override readonly name = 'EvaluationModeError';
  constructor(
    readonly decision: Extract<DispatchDecision, { allowed: false }>,
    readonly correlationId: string,
  ) {
    super(`${decision.reason} ${decision.operatorAction}`);
  }
}

/** Throw unless the subject may be sent. The pipeline calls this before every provider call. */
export function assertDispatchAllowed(mode: EvaluationMode, subject: DispatchSubject): void {
  const decision = canDispatchToProvider(mode, subject);
  if (!decision.allowed) throw new EvaluationModeError(decision, subject.correlationId);
}

// --------------------------------------------------------------------------
// What the operator is shown
// --------------------------------------------------------------------------

export type ProviderReadiness =
  | 'no_worker'
  | 'worker_stale'
  | 'no_provider'
  | 'demo_fixtures'
  | 'local_model'
  | 'synthetic_only'
  | 'production_judging';

export interface ProviderStatus {
  readiness: ProviderReadiness;
  /** One line, in the admin header. */
  label: string;
  /** What it means for the operator's next action. */
  detail: string;
  /** Matches the Alert component's tones, so a status cannot render as a colour that does not exist. */
  tone: 'info' | 'warning' | 'danger' | 'success' | 'accent';
  /** Whether judging a real cohort can proceed at all. */
  canJudgeRealCohort: boolean;
}

/**
 * What a judging worker has reported about itself.
 *
 * Shaped to match the store's `WorkerStatus` without importing it — the AI
 * package does not depend on the data layer.
 */
export interface WorkerReport {
  workerId: string;
  aiProvider: string;
  aiModel: string | null;
  evaluationMode: EvaluationMode;
  demoMode: boolean;
  lastSeenAt: Date;
}

/**
 * How long a worker may be silent before its report stops being evidence.
 *
 * Longer than any poll interval and longer than a single assessment, so a
 * worker busy on one slow browser run is not called missing.
 */
const WORKER_STALE_AFTER_MS = 15 * 60_000;

/**
 * Describe judging in the terms an operator cares about.
 *
 * The important thing about this function is *whose* configuration it reads.
 * Judging runs in a separate worker process, on a separate host, with its own
 * environment; the web application never constructs an AI client and never
 * calls a provider. So its own `AI_PROVIDER` and `AI_API_KEY` say nothing
 * whatsoever about whether a cohort will really be judged.
 *
 * They were nevertheless what this described, and on a production deployment
 * with no AI key of its own — correctly, since it needs none — the only states
 * reachable were the two that say judging is not real. A cohort being judged
 * against real Gemini was captioned "Demo fixtures — no AI provider".
 *
 * So the worker's own report is preferred whenever there is one, and the local
 * environment is used only as a fallback for single-process demo mode, where
 * there genuinely is no separate worker to hear from.
 */
export function describeProviderStatus(config: {
  provider: string;
  model?: string;
  hasApiKey: boolean;
  evaluationMode: EvaluationMode;
  demoMode: boolean;
  /**
   * The most recently seen worker, if any has ever reported.
   *
   * Takes precedence over every field above, because those describe a process
   * that does not judge.
   */
  worker?: WorkerReport | null;
  /** Injected so the staleness boundary is testable. */
  now?: Date;
}): ProviderStatus {
  if (!config.demoMode) {
    const status = describeFromWorker(config.worker ?? null, config.now ?? new Date());
    if (status) return status;
  }

  if (config.demoMode || config.provider === 'demo') {
    return {
      readiness: 'demo_fixtures',
      label: 'Demo fixtures — no AI provider',
      detail:
        'Judging returns fixed sample results. Nothing is sent anywhere and nothing costs anything.',
      tone: 'info',
      canJudgeRealCohort: false,
    };
  }

  if (config.provider !== 'ollama' && !config.hasApiKey) {
    return {
      readiness: 'no_provider',
      label: 'No AI provider configured',
      detail:
        `AI_PROVIDER is "${config.provider}" but AI_API_KEY is not set, so the worker will not start. ` +
        'Submissions are stored safely and stay available until it is.',
      tone: 'warning',
      canJudgeRealCohort: false,
    };
  }

  if (config.provider === 'ollama') {
    return {
      readiness: 'local_model',
      label: `Local model — ${config.model ?? 'ollama'}`,
      detail:
        'Runs on this machine. Nothing leaves it and nothing is charged. Quality depends entirely ' +
        'on the local model, so treat results as a rehearsal rather than a judgement.',
      tone: 'info',
      canJudgeRealCohort: config.evaluationMode === 'production',
    };
  }

  if (config.evaluationMode === 'synthetic_only') {
    return {
      readiness: 'synthetic_only',
      label: `Internal evaluation — ${config.provider} (${config.model ?? 'default model'})`,
      detail:
        'Only demo and test submissions are sent to the provider. Real learner work is refused, ' +
        'so a real cohort cannot be judged in this mode. Set AI_EVALUATION_MODE=production to change that.',
      tone: 'info',
      canJudgeRealCohort: false,
    };
  }

  return {
    readiness: 'production_judging',
    label: `Production judging — ${config.provider} (${config.model ?? 'default model'})`,
    detail:
      'Real submissions will be sent to an external AI provider and this will incur cost. ' +
      "Confirm the provider's data-retention terms apply to the key in use.",
    tone: 'warning',
    canJudgeRealCohort: true,
  };
}

/**
 * Describe judging from what the worker said, or return null to fall back.
 *
 * Null means "this deployment has no separate worker to describe" — single
 * process demo mode. A worker that has reported and then gone quiet is *not*
 * null: silence from a worker that exists is itself worth showing, and is the
 * state where queued work stops moving.
 */
function describeFromWorker(worker: WorkerReport | null, now: Date): ProviderStatus | null {
  if (!worker) {
    return {
      readiness: 'no_worker',
      label: 'No judging worker has reported',
      detail:
        'Judging runs in a separate worker process, not in this application, and none has ever ' +
        'checked in. Submissions are stored safely and stay queued until one starts.',
      tone: 'warning',
      canJudgeRealCohort: false,
    };
  }

  const silentForMs = now.getTime() - worker.lastSeenAt.getTime();
  const model = worker.aiModel ?? 'default model';

  if (silentForMs > WORKER_STALE_AFTER_MS) {
    const minutes = Math.round(silentForMs / 60_000);
    return {
      readiness: 'worker_stale',
      label: `Judging worker last seen ${minutes} minutes ago`,
      detail:
        `Worker "${worker.workerId}" reported ${worker.aiProvider} (${model}) but has not checked ` +
        'in since. Queued work is safe and nothing is lost, but nothing is being judged either.',
      tone: 'warning',
      canJudgeRealCohort: false,
    };
  }

  if (worker.demoMode || worker.aiProvider === 'demo') {
    return {
      readiness: 'demo_fixtures',
      label: 'Demo fixtures — no AI provider',
      detail:
        'The judging worker returns fixed sample results. Nothing is sent anywhere and nothing ' +
        'costs anything.',
      tone: 'info',
      canJudgeRealCohort: false,
    };
  }

  if (worker.aiProvider === 'ollama') {
    return {
      readiness: 'local_model',
      label: `Local model — ${worker.aiModel ?? 'ollama'}`,
      detail:
        'The judging worker runs its model locally. Nothing leaves that machine and nothing is ' +
        'charged. Quality depends entirely on the local model, so treat results as a rehearsal ' +
        'rather than a judgement.',
      tone: 'info',
      canJudgeRealCohort: worker.evaluationMode === 'production',
    };
  }

  if (worker.evaluationMode === 'synthetic_only') {
    return {
      readiness: 'synthetic_only',
      label: `Internal evaluation — ${worker.aiProvider} (${model})`,
      detail:
        'The judging worker sends only demo and test submissions to the provider. Real learner ' +
        'work is refused, so a real cohort cannot be judged in this mode. Set ' +
        'AI_EVALUATION_MODE=production on the worker to change that.',
      tone: 'info',
      canJudgeRealCohort: false,
    };
  }

  return {
    readiness: 'production_judging',
    label: `Production judging — ${worker.aiProvider} (${model})`,
    detail:
      'Real submissions are sent to an external AI provider by the judging worker, and this ' +
      "incurs cost. Confirm the provider's data-retention terms apply to the key in use.",
    tone: 'warning',
    canJudgeRealCohort: true,
  };
}
