/**
 * Entity types.
 *
 * These mirror the tables in docs/DATABASE_ERD.md. Both the memory driver
 * (demo mode) and the postgres driver (Phase 2) produce exactly these shapes,
 * so application code cannot tell which backend it is running on.
 */

import type { RubricCategoryKey, EvidenceSource } from '../rubric/index';
import type { AssessmentStage, CohortStatus, SubmissionStatus } from '../domain/status';
import type { DisqualificationReason } from '../domain/disqualification';
import type { ConsistencyTrigger } from '../domain/ranking';
import type { TeamActivityKind } from '../domain/concurrency';
import type { TestStep } from '../testing/dsl';

export type Actor = 'shared-admin' | 'participant' | 'system' | 'worker';

// --------------------------------------------------------------------------
// Admin
// --------------------------------------------------------------------------

export interface AdminAccount {
  id: string;
  username: string;
  passwordHash: string;
  passwordUpdatedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminSession {
  id: string;
  adminId: string;
  sessionTokenHash: string;
  csrfToken: string;
  issuedAt: Date;
  expiresAt: Date;
  rotatedFrom: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
  revokedAt: Date | null;
}

// --------------------------------------------------------------------------
// Cohort and ideas
// --------------------------------------------------------------------------

export interface Cohort {
  id: string;
  name: string;
  code: string;
  description: string;
  timezone: string;
  day12StartAt: Date;
  day13DeadlineAt: Date;
  shortlistTarget: number;
  submissionInstructions: string;
  rubricVersion: string;
  assessmentConfig: AssessmentConfig;
  status: CohortStatus;
  finalisedAt: Date | null;
  /** When submissions actually stopped being accepted. */
  closedAt: Date | null;
  /** How they stopped: an admin pressed close, or the deadline passed. */
  closureType: 'manual' | 'deadline' | null;
  /**
   * Set when reopening after the official deadline. Writes are accepted until
   * this instant, so "reopened" never means "open but rejecting every save".
   */
  acceptingUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssessmentConfig {
  workerConcurrency: number;
  browserBudgetMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  gracePeriodMs: number;
  consistencyTopN: number;
  lowConfidenceThreshold: number;
  modelVersion: string;
  promptVersion: string;
}

export interface CohortIdea {
  id: string;
  cohortId: string;
  title: string;
  slug: string;
  description: string;
  targetUser: string;
  expectedUseCase: string;
  /** The minimum flow a compliant implementation must support — drives test planning. */
  minimumCoreFlow: string[];
  expectedEntities: string[];
  aiOpportunity: string;
  allowedScope: string;
  unsafeInterpretations: string;
  displayOrder: number;
  isActive: boolean;
  /**
   * Title and description come from the approved source catalogue. The expanded
   * judging fields — minimum flow, entities, AI opportunity, allowed and
   * prohibited scope — are our interpretation, and only influence real judging
   * once approved (ADR-025).
   */
  definitionStatus: 'draft' | 'approved';
  definitionApprovedAt: Date | null;
  definitionApprovedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --------------------------------------------------------------------------
// Teams
// --------------------------------------------------------------------------

export interface Team {
  id: string;
  cohortId: string;
  groupNumber: number;
  /**
   * Nullable since migration 0005.
   *
   * The learner allocation sheet does not designate a lead — it lists learners
   * against a group number and nothing more. Teams created from it genuinely
   * have no lead, and a placeholder like "Group 12" would be a fabricated
   * person's name appearing in exports and on screen.
   */
  leadName: string | null;
  leadEmail: string | null;
  leadPhone: string;
  /** Operational contact link from the allocation sheet. Never used for authentication. */
  whatsappLink: string | null;
  status: 'active' | 'withdrawn';
  importedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  id: string;
  teamId: string;
  fullName: string;
  /**
   * Set when the member came from the allocation sheet; null when a team typed
   * the name in themselves. It is the identity used to recognise the same
   * learner on re-import, which is why it is unique per team.
   */
  email: string | null;
  contribution: string;
  displayOrder: number;
  isActive: boolean;
}

/**
 * A team's access code.
 *
 * Versioned: regenerating increments `version`, which invalidates every
 * participant session minted under the old code without having to find them.
 * Only the Argon2id hash is stored — plaintext is shown once, at generation.
 */
export interface TeamAccessCode {
  id: string;
  teamId: string;
  cohortId: string;
  groupNumber: number;
  codeHash: string;
  version: number;
  createdAt: Date;
  revokedAt: Date | null;
  lastVerifiedAt: Date | null;
  verifyCount: number;
}

/** A verified team session. The access code itself never travels again. */
export interface ParticipantSession {
  id: string;
  teamId: string;
  cohortId: string;
  sessionTokenHash: string;
  /** An activity label, never verified identity. */
  editorName: string;
  editorRole: string | null;
  accessCodeVersion: number;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ipHash: string | null;
}

/** Learner-safe activity, distinct from the internal audit log. */
export interface TeamActivity {
  id: string;
  submissionId: string;
  teamId: string;
  /** Closed set, matching the CHECK constraint on the table. */
  kind: TeamActivityKind;
  editorName: string;
  section: string | null;
  createdAt: Date;
}

/** Rate-limit state for /submit verification, keyed by hashed IP + group. */
export interface VerificationAttempt {
  id: string;
  cohortId: string;
  groupNumber: number;
  ipHash: string;
  attempts: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  updatedAt: Date;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  tokenHash: string;
  tokenPrefix: string;
  issuedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastAccessedAt: Date | null;
  accessCount: number;
}

// --------------------------------------------------------------------------
// Submissions
// --------------------------------------------------------------------------

export interface Submission {
  id: string;
  cohortId: string;
  teamId: string;
  status: SubmissionStatus;
  ideaId: string | null;

  productName: string | null;
  primaryUser: string | null;
  exactProblem: string | null;
  oneSentencePromise: string | null;
  briefDescription: string | null;
  whyAiNecessary: string | null;
  differentiation: string | null;
  mustHaveWorkflow: string | null;
  shouldHaveFeatures: string[];
  excludedFeatures: string | null;

  productUrl: string | null;
  loginRequired: boolean;
  coreTestSteps: { action: string; expectedResult: string }[];
  safeSampleInputs: string | null;
  resetInstructions: string | null;
  knownLimitations: string | null;

  bugsFixed: { description: string; howFixed: string }[];
  deliberatelyExcluded: string | null;
  majorTradeoff: string | null;
  day12ToDay13Changes: string | null;
  mostImportantLearning: string | null;
  nextSevenDayPlan: string | null;
  builderStack: string | null;
  apisUsed: string | null;
  externalTemplates: string | null;

  /** Raw autosaved draft, kept separate from the promoted columns. */
  draftPayload: Record<string, unknown>;
  /** Optimistic-concurrency version. Every write carries the version it read. */
  version: number;
  draftUpdatedAt: Date | null;
  /** Activity label of whoever last saved. Not verified identity. */
  lastEditedBy: string | null;
  submittedAt: Date | null;
  /** Activity label of whoever pressed Final Submit. */
  submittedByName: string | null;
  receiptId: string | null;
  lockedAt: Date | null;
  reopenedAt: Date | null;
  reopenedReason: string | null;
  isLate: boolean;
  hasLateException: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type ArtifactKind = 'deck_pdf' | 'demo_video' | 'transcript' | 'screenshot';

export interface SubmissionArtifact {
  id: string;
  submissionId: string;
  kind: ArtifactKind;
  storageBucket: string | null;
  storagePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  externalUrl: string | null;
  uploadCompletedAt: Date | null;
  isAccessible: boolean | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

/** Stored ciphertext only. There is no plaintext field anywhere in this type. */
export interface SubmissionCredentials {
  id: string;
  submissionId: string;
  usernameCiphertext: string | null;
  passwordCiphertext: string | null;
  loginInstructionsCiphertext: string | null;
  keyVersion: number;
  deletedAt: Date | null;
  lastRevealedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmissionDeclarations {
  id: string;
  submissionId: string;
  builtDuringHackathon: boolean;
  ownedByTeam: boolean;
  externalMaterialDisclosed: boolean;
  judgeMayModifyDemoData: boolean;
  noRealCustomerData: boolean;
  urlsAvailableThroughJudging: boolean;
  permissionToSubmit: boolean;
  acceptedAt: Date | null;
  acceptedIpHash: string | null;
}

export interface SubmissionEvent {
  id: string;
  submissionId: string;
  eventType: string;
  actorType: Actor;
  detail: Record<string, unknown>;
  createdAt: Date;
}

// --------------------------------------------------------------------------
// Assessment
// --------------------------------------------------------------------------

export interface AssessmentJob {
  id: string;
  submissionId: string;
  cohortId: string;
  stage: AssessmentStage;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PreflightStatus = 'pass' | 'fail' | 'warn' | 'skipped';
export type FailureClass = 'timeout' | 'dns' | 'auth' | 'server' | 'blocked' | 'invalid' | 'none';

export interface PreflightCheck {
  id: string;
  jobId: string;
  checkKey: string;
  status: PreflightStatus;
  attemptNumber: number;
  failureClass: FailureClass;
  detail: Record<string, unknown>;
  checkedAt: Date;
}

export interface ArtifactAnalysis {
  id: string;
  jobId: string;
  deckPageCount: number | null;
  deckTextExtracted: boolean;
  deckAnalysis: Record<string, unknown>;
  videoAnalysisLimited: boolean;
  videoLimitationReason: string | null;
  transcriptAvailable: boolean;
  writtenAnalysis: Record<string, unknown>;
  injectionFlags: InjectionFlag[];
  modelVersion: string;
  promptVersion: string;
  createdAt: Date;
}

export interface InjectionFlag {
  source: 'deck' | 'written' | 'website';
  pattern: string;
  excerpt: string;
  severity: 'low' | 'medium' | 'high';
}

export interface TestPlan {
  id: string;
  jobId: string;
  generatedFrom: Record<string, unknown>;
  stepCount: number;
  estimatedDurationMs: number;
  modelVersion: string;
  promptVersion: string;
  validationStatus: 'valid' | 'partial' | 'rejected';
  rejectedSteps: { index: number; reason: string; raw: string }[];
  summary: string | null;
  createdAt: Date;
}

export interface TestPlanStep {
  id: string;
  testPlanId: string;
  stepIndex: number;
  step: TestStep;
  isCleanup: boolean;
  rationale: string | null;
}

export interface BrowserTestRun {
  id: string;
  jobId: string;
  viewport: 'desktop' | 'mobile';
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  status: 'passed' | 'partial' | 'failed' | 'error';
  browserVersion: string | null;
  tracePath: string | null;
  consoleErrorCount: number;
  networkFailureCount: number;
  a11yViolationCount: number;
  a11ySummary: Record<string, unknown>;
  cleanupStatus: 'complete' | 'partial' | 'not_attempted' | 'failed';
  timedOut: boolean;
}

export interface BrowserTestStep {
  id: string;
  runId: string;
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  screenshotPath: string | null;
  assertionDetail: Record<string, unknown>;
  errorMessage: string | null;
}

export type EvidenceStance = 'supporting' | 'contradictory' | 'missing';

export interface AssessmentEvidence {
  id: string;
  jobId: string;
  categoryKey: RubricCategoryKey;
  evidenceType: EvidenceSource;
  stance: EvidenceStance;
  summary: string;
  sourceRef: Record<string, unknown>;
  confidence: number;
  createdAt: Date;
}

export interface CategoryScore {
  id: string;
  jobId: string;
  categoryKey: RubricCategoryKey;
  rawScore: number;
  maxPoints: number;
  weightedScore: number;
  confidence: number;
  rationale: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  missingEvidence: string[];
  isOverridden: boolean;
  overrideReason: string | null;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  /** The model's original score, preserved across an override (ADR-012). */
  originalRawScore: number | null;
  modelVersion: string;
  promptVersion: string;
  rubricVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssessmentSummary {
  id: string;
  jobId: string;
  totalScore: number;
  meanConfidence: number;
  minConfidence: number;
  lowConfidence: boolean;
  risks: string[];
  strengths: string[];
  weaknesses: string[];
  internalNotes: string | null;
  bugsFound: { description: string; severity: 'low' | 'medium' | 'high'; evidence: string }[];
  modelVersion: string;
  promptVersion: string;
  completedAt: Date | null;
}

export interface ConsistencyReview {
  id: string;
  jobId: string;
  triggerReason: ConsistencyTrigger[];
  passNumber: number;
  scoreDelta: number;
  adjusted: boolean;
  detail: Record<string, unknown>;
  reviewedAt: Date;
}

export interface ManualReviewFlag {
  id: string;
  submissionId: string;
  reasonCode: string;
  detail: string;
  raisedBy: Actor;
  status: 'open' | 'resolved' | 'dismissed';
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export interface Disqualification {
  id: string;
  submissionId: string;
  reasonCode: DisqualificationReason;
  reasonDetail: string;
  evidence: Record<string, unknown>;
  status: 'proposed' | 'confirmed' | 'reversed';
  proposedBy: Actor;
  confirmedBy: string | null;
  reversedBy: string | null;
  reversedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --------------------------------------------------------------------------
// Ranking and selection
// --------------------------------------------------------------------------

export interface RankingSnapshot {
  id: string;
  cohortId: string;
  generatedAt: Date;
  rubricVersion: string;
  eligibleCount: number;
  shortlistTarget: number;
  isCurrent: boolean;
  notes: string | null;
}

export interface RankingEntry {
  id: string;
  snapshotId: string;
  submissionId: string;
  rank: number;
  totalScore: number;
  tiebreakVector: Record<string, number>;
  inShortlist: boolean;
  meanConfidence: number;
}

export interface FinalSelection {
  id: string;
  cohortId: string;
  submissionId: string;
  position: number;
  selectedBy: string;
  selectionReason: string;
  selectedAt: Date;
}

export interface FeedbackReport {
  id: string;
  submissionId: string;
  productSummary: string;
  strengths: string[];
  improvements: { title: string; detail: string; priority: number }[];
  bugs: { description: string; evidence: string }[];
  nextSevenDayPlan: string[];
  /** Always false in Version 1. No route reads this. */
  isExposedToParticipant: boolean;
  generatedAt: Date;
  modelVersion: string;
  promptVersion: string;
}

// --------------------------------------------------------------------------
// Global
// --------------------------------------------------------------------------

export interface ResourceDocument {
  id: string;
  cohortId: string | null;
  kind: 'pitch_template' | 'instructions' | 'playbook' | 'other';
  title: string;
  description: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  isParticipantVisible: boolean;
  displayOrder: number;
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  actorType: Actor;
  actorRef: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  cohortId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipHash: string | null;
  userAgentHash: string | null;
  createdAt: Date;
}

export interface SystemSetting {
  key: string;
  value: unknown;
  description: string;
  updatedBy: string | null;
  updatedAt: Date;
}

// --------------------------------------------------------------------------
// Composite read models
// --------------------------------------------------------------------------

/** Everything a participant may see. Contains no assessment data by construction. */
export interface ParticipantView {
  cohort: Pick<
    Cohort,
    'id' | 'name' | 'code' | 'description' | 'timezone' | 'day12StartAt' | 'day13DeadlineAt' | 'submissionInstructions' | 'status'
  >;
  team: Pick<Team, 'id' | 'groupNumber' | 'leadName' | 'leadEmail' | 'leadPhone'>;
  members: TeamMember[];
  submission: Submission;
  artifacts: SubmissionArtifact[];
  declarations: SubmissionDeclarations | null;
  ideas: CohortIdea[];
  /** True when credentials are stored — never the values themselves. */
  hasStoredCredentials: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  /** Why editing is or is not permitted, safe to show a participant. */
  windowMessage: string;
  effectiveDeadline: Date;
  /** Activity label of the person editing in this session. */
  editorName: string;
  /** Learner-safe recent activity by the team. */
  recentActivity: TeamActivity[];
}

/** The admin view of one submission. */
export interface AdminSubmissionDetail {
  submission: Submission;
  team: Team;
  members: TeamMember[];
  cohort: Cohort;
  idea: CohortIdea | null;
  artifacts: SubmissionArtifact[];
  declarations: SubmissionDeclarations | null;
  credentials: SubmissionCredentials | null;
  events: SubmissionEvent[];
  job: AssessmentJob | null;
  preflight: PreflightCheck[];
  artifactAnalysis: ArtifactAnalysis | null;
  testPlan: (TestPlan & { steps: TestPlanStep[] }) | null;
  browserRuns: (BrowserTestRun & { steps: BrowserTestStep[] })[];
  evidence: AssessmentEvidence[];
  scores: CategoryScore[];
  summary: AssessmentSummary | null;
  consistencyReviews: ConsistencyReview[];
  manualReviewFlags: ManualReviewFlag[];
  disqualifications: Disqualification[];
  feedbackReport: FeedbackReport | null;
  auditLogs: AuditLog[];
  rank: number | null;
  inShortlist: boolean;
}

/**
 * What the judging pipeline is given, and the boundary of what it can see.
 *
 * Deliberately not `AdminSubmissionDetail`. That type carries the participant
 * event timeline, the audit trail, manual review flags, feedback reports and —
 * the part that matters — `rank` and `inShortlist`, read from the ranking
 * tables. The worker must never see any of it: the system ranks privately and
 * Outskill humans choose the Final Four (ADR-018), and a judging process that
 * cannot read the ranking cannot be influenced by it.
 *
 * Every field here is one the pipeline actually dereferences. Adding to this
 * type is how a new judging input gets introduced — visibly, and with the
 * matching database grant — rather than arriving free with an admin view.
 */
export interface JudgingInput {
  submission: Submission;
  team: Team;
  members: TeamMember[];
  cohort: Cohort;
  idea: CohortIdea | null;
  artifacts: SubmissionArtifact[];
  /** The previous stage's analysis of the deck and written answers, if it ran. */
  artifactAnalysis: ArtifactAnalysis | null;
}
