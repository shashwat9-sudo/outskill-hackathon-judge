/**
 * Disqualification rules.
 *
 * Disqualification is the most damaging action the system can take, so it is
 * constrained on both sides:
 *
 *   - PERMITTED_REASONS is a closed list. Anything else cannot be recorded —
 *     the database CHECK constraint mirrors this union (ADR-017).
 *   - NEVER_DISQUALIFY documents grounds that are explicitly not permitted, so
 *     the rule survives as executable intent rather than as prose in a doc.
 *
 * The system may PROPOSE a disqualification. Only an admin confirms one, and
 * every confirmation is reversible and audit-logged.
 */

export const DISQUALIFICATION_REASONS = [
  'late_submission_no_exception',
  'idea_outside_approved_list',
  'missing_product_url',
  'missing_pdf_deck',
  'missing_demo_link',
  'artifact_inaccessible_after_retries',
  'login_required_without_working_credentials',
  'malicious_or_prohibited_content',
  'interference_with_judging',
  'confirmed_false_declaration',
  'confirmed_serious_rule_violation',
] as const;

export type DisqualificationReason = (typeof DISQUALIFICATION_REASONS)[number];

export interface DisqualificationReasonDefinition {
  code: DisqualificationReason;
  label: string;
  /** Whether the system may propose this automatically, or only a human may raise it. */
  autoProposable: boolean;
  /** What must be true before this can be confirmed. */
  requires: string;
}

export const DISQUALIFICATION_DEFINITIONS: readonly DisqualificationReasonDefinition[] = [
  {
    code: 'late_submission_no_exception',
    label: 'Final submission after the deadline, with no approved exception',
    autoProposable: true,
    requires: 'submitted_at is after the cohort deadline and no admin exception is recorded.',
  },
  {
    code: 'idea_outside_approved_list',
    label: 'Product is not one of the approved ideas for the cohort',
    autoProposable: true,
    requires: 'The selected idea is not an active idea for this cohort.',
  },
  {
    code: 'missing_product_url',
    label: 'No live product URL supplied',
    autoProposable: true,
    requires: 'product_url is empty on a finally-submitted submission.',
  },
  {
    code: 'missing_pdf_deck',
    label: 'No PDF pitch deck supplied',
    autoProposable: true,
    requires: 'No completed deck_pdf artifact exists.',
  },
  {
    code: 'missing_demo_link',
    label: 'No demo video link supplied',
    autoProposable: true,
    requires: 'No demo_video artifact exists.',
  },
  {
    code: 'artifact_inaccessible_after_retries',
    label: 'A required artifact stayed unreachable after retries and the grace period',
    autoProposable: true,
    requires:
      'All retry attempts exhausted AND the grace period elapsed AND failures were not classified as a temporary outage.',
  },
  {
    code: 'login_required_without_working_credentials',
    label: 'Login is required but no working credentials were supplied',
    autoProposable: true,
    requires: 'login_required is true AND credentials are absent or verified non-working.',
  },
  {
    code: 'malicious_or_prohibited_content',
    label: 'Malicious or prohibited content',
    autoProposable: false,
    requires: 'Human confirmation. Never raised automatically.',
  },
  {
    code: 'interference_with_judging',
    label: 'Interference with automated judging',
    autoProposable: false,
    requires: 'Human confirmation with evidence. Prompt-injection detection alone is a flag, not a ground.',
  },
  {
    code: 'confirmed_false_declaration',
    label: 'Confirmed false declaration',
    autoProposable: false,
    requires: 'Human confirmation. "Confirmed" means verified, not suspected.',
  },
  {
    code: 'confirmed_serious_rule_violation',
    label: 'Confirmed serious rule violation',
    autoProposable: false,
    requires: 'Human confirmation with recorded evidence.',
  },
] as const;

/**
 * Grounds that are explicitly NOT disqualifying.
 *
 * Kept as executable data so `isPermittedDisqualificationReason` can be tested
 * against them directly — the rule is enforced, not just documented.
 */
export const NEVER_DISQUALIFY = [
  'weak_ui',
  'low_score',
  'secondary_feature_failure',
  'missing_optional_feature',
  'low_commercial_potential',
  'ordinary_bugs',
  'temporary_external_outage',
  'ai_suspicion_without_human_confirmation',
] as const;

export type NeverDisqualifyReason = (typeof NEVER_DISQUALIFY)[number];

export function isPermittedDisqualificationReason(code: string): code is DisqualificationReason {
  return (DISQUALIFICATION_REASONS as readonly string[]).includes(code);
}

export function isAutoProposable(code: DisqualificationReason): boolean {
  return DISQUALIFICATION_DEFINITIONS.find((d) => d.code === code)?.autoProposable ?? false;
}

export class DisqualificationRuleError extends Error {
  override readonly name = 'DisqualificationRuleError';
}

/**
 * Gate every disqualification write through this.
 *
 * Throws rather than returning false: recording an impermissible
 * disqualification is a bug that must not be swallowed by a caller ignoring a
 * boolean.
 */
export function assertDisqualificationAllowed(
  code: string,
  options: { proposedBySystem: boolean },
): asserts code is DisqualificationReason {
  if (!isPermittedDisqualificationReason(code)) {
    throw new DisqualificationRuleError(
      `"${code}" is not a permitted disqualification ground. Permitted grounds: ${DISQUALIFICATION_REASONS.join(', ')}.`,
    );
  }
  if (options.proposedBySystem && !isAutoProposable(code)) {
    throw new DisqualificationRuleError(
      `"${code}" requires human confirmation and may not be proposed automatically.`,
    );
  }
}

// --------------------------------------------------------------------------
// Automatic proposal
// --------------------------------------------------------------------------

export interface DisqualificationCandidateInput {
  hasProductUrl: boolean;
  hasDeckPdf: boolean;
  hasDemoLink: boolean;
  ideaIsApproved: boolean;
  isLate: boolean;
  hasLateException: boolean;
  loginRequired: boolean;
  hasWorkingCredentials: boolean;
  requiredArtifactInaccessible: boolean;
  retriesExhausted: boolean;
  gracePeriodElapsed: boolean;
  /** True when failures were classified as a temporary outage rather than a real absence. */
  failuresLookLikeOutage: boolean;
}

export interface DisqualificationProposal {
  code: DisqualificationReason;
  detail: string;
}

/**
 * Propose disqualifications from objective facts.
 *
 * Everything returned is a PROPOSAL requiring admin confirmation. Note the
 * outage guard: a product that was unreachable because its host was down is
 * never proposed, because a temporary outage is explicitly not disqualifying.
 */
export function proposeDisqualifications(
  input: DisqualificationCandidateInput,
): DisqualificationProposal[] {
  const proposals: DisqualificationProposal[] = [];

  if (input.isLate && !input.hasLateException) {
    proposals.push({
      code: 'late_submission_no_exception',
      detail: 'Final submission was recorded after the cohort deadline and no exception is on file.',
    });
  }
  if (!input.ideaIsApproved) {
    proposals.push({
      code: 'idea_outside_approved_list',
      detail: 'The selected product idea is not an active approved idea for this cohort.',
    });
  }
  if (!input.hasProductUrl) {
    proposals.push({ code: 'missing_product_url', detail: 'No live product URL was supplied.' });
  }
  if (!input.hasDeckPdf) {
    proposals.push({ code: 'missing_pdf_deck', detail: 'No PDF pitch deck was uploaded.' });
  }
  if (!input.hasDemoLink) {
    proposals.push({ code: 'missing_demo_link', detail: 'No demo video link was supplied.' });
  }
  if (input.loginRequired && !input.hasWorkingCredentials) {
    proposals.push({
      code: 'login_required_without_working_credentials',
      detail: 'The team declared that login is required but no working demo credentials were supplied.',
    });
  }
  if (
    input.requiredArtifactInaccessible &&
    input.retriesExhausted &&
    input.gracePeriodElapsed &&
    !input.failuresLookLikeOutage
  ) {
    proposals.push({
      code: 'artifact_inaccessible_after_retries',
      detail: 'A required artifact remained unreachable after all retries and the grace period elapsed.',
    });
  }

  return proposals;
}

/**
 * Eligibility for ranking.
 *
 * Only confirmed disqualifications remove a submission. A proposal does not —
 * otherwise an unreviewed automatic proposal would silently drop a team from
 * the ranking before any human looked at it.
 */
export function isEligibleForRanking(input: {
  submissionStatus: string;
  hasConfirmedDisqualification: boolean;
  hasCompleteScores: boolean;
}): boolean {
  if (input.hasConfirmedDisqualification) return false;
  if (!input.hasCompleteScores) return false;
  return input.submissionStatus === 'submitted' || input.submissionStatus === 'locked';
}
