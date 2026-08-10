/**
 * Repository interfaces.
 *
 * Application code depends on these, never on a driver (ADR-003). Two drivers
 * implement them: `memory` (demo mode, deterministic) and `postgres` (Phase 2).
 *
 * The interfaces are split by trust level, and that split is the participant
 * isolation control (ADR-010): `ParticipantStore` has no method that can reach
 * an assessment table. The capability is absent, not guarded — a future
 * participant surface cannot leak scores by forgetting a check, because there
 * is nothing to call.
 */

import type {
  AdminAccount,
  AdminSession,
  AdminSubmissionDetail,
  ArtifactAnalysis,
  AssessmentEvidence,
  AssessmentJob,
  AssessmentSummary,
  AuditLog,
  BrowserTestRun,
  BrowserTestStep,
  CategoryScore,
  Cohort,
  CohortIdea,
  ConsistencyReview,
  Disqualification,
  FeedbackReport,
  FinalSelection,
  ManualReviewFlag,
  ParticipantView,
  PreflightCheck,
  RankingEntry,
  RankingSnapshot,
  ResourceDocument,
  Submission,
  SubmissionArtifact,
  SubmissionCredentials,
  SubmissionDeclarations,
  SubmissionEvent,
  SystemSetting,
  Team,
  TeamInvite,
  TeamMember,
  TestPlan,
  TestPlanStep,
} from './types.js';
import type { AssessmentStage, CohortStatus, SubmissionStatus } from '../domain/status.js';

// --------------------------------------------------------------------------
// Participant surface — deliberately narrow
// --------------------------------------------------------------------------

export interface ParticipantStore {
  /**
   * Resolve an invite token to everything the team may see.
   * Returns null for an unknown, revoked, or expired token — the caller must
   * not be able to distinguish which, to avoid confirming token existence.
   */
  resolveInvite(token: string): Promise<ParticipantView | null>;

  /** Autosave. Accepts partial data; never validates strictly. */
  saveDraft(submissionId: string, draft: Record<string, unknown>): Promise<Submission>;

  /** Final Submit. Fails if the cohort is closed or the submission is locked. */
  finaliseSubmission(
    submissionId: string,
    context: { ipHash: string | null },
  ): Promise<{ submission: Submission; receiptId: string }>;

  /** Record a deck or screenshot upload against the submission. */
  attachArtifact(
    submissionId: string,
    artifact: Omit<SubmissionArtifact, 'id' | 'submissionId' | 'createdAt'>,
  ): Promise<SubmissionArtifact>;

  removeArtifact(submissionId: string, artifactId: string): Promise<void>;

  /** Store demo credentials. Takes plaintext, stores only ciphertext. */
  storeCredentials(
    submissionId: string,
    values: { username?: string; password?: string; loginInstructions?: string },
  ): Promise<void>;

  /** Participant-visible resources: pitch template, instructions. */
  listParticipantResources(cohortId: string): Promise<ResourceDocument[]>;

  recordEvent(
    submissionId: string,
    event: { eventType: string; detail?: Record<string, unknown> },
  ): Promise<void>;
}

// --------------------------------------------------------------------------
// Admin surface
// --------------------------------------------------------------------------

export interface AdminAuthStore {
  getAdminAccount(): Promise<AdminAccount | null>;
  createAdminAccount(username: string, passwordHash: string): Promise<AdminAccount>;
  updateAdminLockout(state: { failedAttempts: number; lockedUntil: Date | null }): Promise<void>;
  recordSuccessfulLogin(): Promise<void>;
  rotateCredentials(input: { username?: string; passwordHash?: string }): Promise<void>;

  createSession(input: {
    sessionTokenHash: string;
    csrfToken: string;
    expiresAt: Date;
    rotatedFrom: string | null;
    ipHash: string | null;
    userAgentHash: string | null;
  }): Promise<AdminSession>;
  getSessionByHash(hash: string): Promise<AdminSession | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(): Promise<void>;
}

export interface CohortStore {
  listCohorts(): Promise<Cohort[]>;
  getCohort(id: string): Promise<Cohort | null>;
  getCohortByCode(code: string): Promise<Cohort | null>;
  createCohort(input: Omit<Cohort, 'id' | 'createdAt' | 'updatedAt' | 'finalisedAt'>): Promise<Cohort>;
  updateCohort(id: string, patch: Partial<Cohort>): Promise<Cohort>;
  setCohortStatus(id: string, status: CohortStatus): Promise<Cohort>;

  listIdeas(cohortId: string, options?: { includeInactive?: boolean }): Promise<CohortIdea[]>;
  getIdea(id: string): Promise<CohortIdea | null>;
  createIdea(input: Omit<CohortIdea, 'id' | 'createdAt' | 'updatedAt'>): Promise<CohortIdea>;
  updateIdea(id: string, patch: Partial<CohortIdea>): Promise<CohortIdea>;
  deleteIdea(id: string): Promise<void>;
  cloneIdeas(fromCohortId: string, toCohortId: string): Promise<CohortIdea[]>;
}

export interface TeamStore {
  listTeams(cohortId: string): Promise<(Team & { members: TeamMember[]; invite: TeamInvite | null })[]>;
  getTeam(id: string): Promise<Team | null>;
  importTeams(
    cohortId: string,
    rows: { groupNumber: number; leadName: string; leadEmail: string; leadPhone: string }[],
  ): Promise<TeamImportResult>;
  generateInvite(teamId: string): Promise<{ invite: TeamInvite; token: string }>;
  revokeInvite(teamId: string): Promise<void>;
}

export interface TeamImportResult {
  created: Team[];
  skipped: { row: number; groupNumber: number | null; reason: string }[];
  invites: { teamId: string; groupNumber: number; leadEmail: string; token: string }[];
}

export interface SubmissionStore {
  listSubmissions(
    cohortId: string,
    filter?: { status?: SubmissionStatus; stage?: AssessmentStage; search?: string },
  ): Promise<SubmissionListItem[]>;
  getSubmission(id: string): Promise<Submission | null>;
  getSubmissionDetail(id: string): Promise<AdminSubmissionDetail | null>;
  reopenSubmission(id: string, reason: string): Promise<Submission>;
  lockSubmission(id: string): Promise<Submission>;
  setLateException(id: string, granted: boolean, reason: string): Promise<Submission>;
  getCredentials(submissionId: string): Promise<SubmissionCredentials | null>;
  /** Decrypts. Audited by the caller — this is a privileged action. */
  revealCredentials(submissionId: string): Promise<{ username: string; password: string; loginInstructions: string } | null>;
  deleteCredentials(submissionId: string): Promise<void>;
  listArtifacts(submissionId: string): Promise<SubmissionArtifact[]>;
  getDeclarations(submissionId: string): Promise<SubmissionDeclarations | null>;
  listEvents(submissionId: string): Promise<SubmissionEvent[]>;
}

export interface SubmissionListItem {
  submission: Submission;
  team: Team;
  ideaTitle: string | null;
  stage: AssessmentStage | null;
  totalScore: number | null;
  meanConfidence: number | null;
  lowConfidence: boolean;
  rank: number | null;
  inShortlist: boolean;
  hasOpenManualReview: boolean;
  disqualificationStatus: 'none' | 'proposed' | 'confirmed' | 'reversed';
}

export interface AssessmentStore {
  /** Queue every eligible submission in a cohort. Idempotent. */
  enqueueCohort(cohortId: string): Promise<{ queued: number; skipped: number }>;
  enqueueSubmission(submissionId: string): Promise<AssessmentJob>;
  getJob(jobId: string): Promise<AssessmentJob | null>;
  getJobBySubmission(submissionId: string): Promise<AssessmentJob | null>;
  listJobs(cohortId: string, filter?: { stage?: AssessmentStage }): Promise<AssessmentJob[]>;

  /**
   * Claim jobs for processing.
   * The postgres driver uses SELECT ... FOR UPDATE SKIP LOCKED; the memory
   * driver simulates the same lease semantics so behaviour matches in tests.
   */
  claimJobs(input: { workerId: string; limit: number; leaseSeconds: number }): Promise<AssessmentJob[]>;
  heartbeat(jobId: string, workerId: string): Promise<void>;
  advanceStage(jobId: string, stage: AssessmentStage, error?: string | null): Promise<AssessmentJob>;
  releaseJob(jobId: string, options: { retryInMs?: number; error?: string }): Promise<AssessmentJob>;
  reclaimExpiredLeases(): Promise<number>;

  recordPreflight(jobId: string, checks: Omit<PreflightCheck, 'id' | 'jobId'>[]): Promise<void>;
  listPreflight(jobId: string): Promise<PreflightCheck[]>;

  saveArtifactAnalysis(analysis: Omit<ArtifactAnalysis, 'id' | 'createdAt'>): Promise<ArtifactAnalysis>;
  saveTestPlan(
    plan: Omit<TestPlan, 'id' | 'createdAt'>,
    steps: Omit<TestPlanStep, 'id' | 'testPlanId'>[],
  ): Promise<TestPlan>;
  getTestPlan(jobId: string): Promise<(TestPlan & { steps: TestPlanStep[] }) | null>;

  saveBrowserRun(
    run: Omit<BrowserTestRun, 'id'>,
    steps: Omit<BrowserTestStep, 'id' | 'runId'>[],
  ): Promise<BrowserTestRun>;
  listBrowserRuns(jobId: string): Promise<(BrowserTestRun & { steps: BrowserTestStep[] })[]>;

  saveEvidence(jobId: string, evidence: Omit<AssessmentEvidence, 'id' | 'jobId' | 'createdAt'>[]): Promise<void>;
  listEvidence(jobId: string): Promise<AssessmentEvidence[]>;

  saveScores(jobId: string, scores: Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[]): Promise<void>;
  listScores(jobId: string): Promise<CategoryScore[]>;
  overrideScore(input: {
    jobId: string;
    categoryKey: string;
    rawScore: number;
    reason: string;
    actor: string;
  }): Promise<CategoryScore>;

  saveSummary(summary: Omit<AssessmentSummary, 'id'>): Promise<AssessmentSummary>;
  getSummary(jobId: string): Promise<AssessmentSummary | null>;

  saveConsistencyReview(review: Omit<ConsistencyReview, 'id'>): Promise<ConsistencyReview>;
  saveFeedbackReport(report: Omit<FeedbackReport, 'id'>): Promise<FeedbackReport>;
  getFeedbackReport(submissionId: string): Promise<FeedbackReport | null>;

  raiseManualReview(flag: Omit<ManualReviewFlag, 'id' | 'createdAt'>): Promise<ManualReviewFlag>;
  resolveManualReview(flagId: string, resolution: { status: 'resolved' | 'dismissed'; note: string; actor: string }): Promise<void>;
  listManualReviewFlags(cohortId: string): Promise<(ManualReviewFlag & { groupNumber: number })[]>;

  proposeDisqualification(input: Omit<Disqualification, 'id' | 'createdAt' | 'updatedAt'>): Promise<Disqualification>;
  confirmDisqualification(id: string, actor: string): Promise<Disqualification>;
  reverseDisqualification(id: string, actor: string, reason: string): Promise<Disqualification>;
  listDisqualifications(cohortId: string): Promise<Disqualification[]>;

  getQueueStats(cohortId: string): Promise<QueueStats>;
}

export interface QueueStats {
  total: number;
  byStage: Record<AssessmentStage, number>;
  completed: number;
  running: number;
  failed: number;
  manualReview: number;
  /** Rolling average of completed job durations, used for the ETA. */
  averageDurationMs: number | null;
  projectedCompletionAt: Date | null;
  browserMinutesUsed: number;
  aiCallCount: number;
  estimatedTokensUsed: number;
}

export interface RankingStore {
  generateSnapshot(cohortId: string, notes?: string): Promise<RankingSnapshot>;
  getCurrentSnapshot(cohortId: string): Promise<(RankingSnapshot & { entries: RankedListItem[] }) | null>;
  listSnapshots(cohortId: string): Promise<RankingSnapshot[]>;

  listFinalSelections(cohortId: string): Promise<(FinalSelection & { groupNumber: number; productName: string | null })[]>;
  /**
   * Set the final four. Admin-action-only: no worker, stage, or AI response has
   * a call path to this method (ADR-018).
   */
  setFinalSelection(
    cohortId: string,
    selections: { submissionId: string; position: number; reason: string }[],
    actor: string,
  ): Promise<FinalSelection[]>;
  clearFinalSelection(cohortId: string, actor: string): Promise<void>;
}

export interface RankedListItem {
  entry: RankingEntry;
  submissionId: string;
  groupNumber: number;
  productName: string | null;
  ideaTitle: string | null;
  lowConfidence: boolean;
  hasOpenManualReview: boolean;
}

export interface ResourceStore {
  listResources(cohortId: string | null): Promise<ResourceDocument[]>;
  createResource(input: Omit<ResourceDocument, 'id' | 'createdAt'>): Promise<ResourceDocument>;
  deleteResource(id: string): Promise<void>;
  /** Short-lived signed URL. Buckets are private; this is the only read path. */
  getSignedUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string>;
}

export interface AuditStore {
  record(entry: Omit<AuditLog, 'id' | 'createdAt'>): Promise<void>;
  list(filter: { entityType?: string; entityId?: string; cohortId?: string; limit?: number }): Promise<AuditLog[]>;
}

export interface SettingsStore {
  getAll(): Promise<SystemSetting[]>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, actor: string): Promise<void>;
}

// --------------------------------------------------------------------------
// Composite
// --------------------------------------------------------------------------

export interface DataStore {
  readonly driver: 'memory' | 'postgres';
  participant: ParticipantStore;
  adminAuth: AdminAuthStore;
  cohorts: CohortStore;
  teams: TeamStore;
  submissions: SubmissionStore;
  assessment: AssessmentStore;
  ranking: RankingStore;
  resources: ResourceStore;
  audit: AuditStore;
  settings: SettingsStore;
  /** Demo mode only — resets to the deterministic fixture state. */
  reset?(): Promise<void>;
}
