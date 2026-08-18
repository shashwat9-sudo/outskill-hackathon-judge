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
  TeamActivity,
  TeamInvite,
  TeamMember,
  TestPlan,
  TestPlanStep,
} from './types';
import type { AssessmentStage, CohortStatus, SubmissionStatus } from '../domain/status';
import type { CohortDependencies } from '../domain/cohort-deletion';
import type { TeamActivityKind } from '../domain/concurrency';

// --------------------------------------------------------------------------
// Participant surface — deliberately narrow
// --------------------------------------------------------------------------

/**
 * What a verification attempt produced.
 *
 * Every failure mode collapses to `ok: false` with the SAME generic message, so
 * the /submit form cannot be used to discover which group numbers exist. Only
 * rate limiting is distinguishable, because a locked-out team needs to know to
 * wait rather than keep guessing.
 */
export type VerifyTeamResult =
  | { ok: true; teamId: string; cohortId: string; groupNumber: number }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'rate_limited'; message: string; retryAfterSeconds: number };

export interface CreateSessionInput {
  teamId: string;
  editorName: string;
  editorRole: string | null;
  ipHash: string | null;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface SaveDraftResult {
  ok: boolean;
  /** Set when the write was rejected as stale. */
  conflict?: { currentVersion: number; message: string };
  submission?: Submission;
  error?: string;
}

export interface FinaliseResult {
  ok: boolean;
  receiptId?: string;
  error?: string;
  conflict?: { currentVersion: number; message: string };
}

/** Everything the receipt shows. Contains no code, credential or internal id. */
export interface ParticipantReceipt {
  cohortName: string;
  cohortTimezone: string;
  groupNumber: number;
  productName: string;
  ideaTitle: string;
  submittedByName: string;
  submittedAt: Date;
  receiptId: string;
}

/**
 * Participant surface — deliberately narrow.
 *
 * Every method takes the SESSION TOKEN, never a submission id: the team is
 * derived server-side from the session, so a tampered request cannot address
 * another team's record. There is still no method here capable of reaching an
 * assessment table (ADR-010).
 */
export interface ParticipantStore {
  /**
   * Verify a group number and access code. Does not create a session — the
   * editor name is collected first.
   */
  verifyTeamAccess(input: {
    groupNumber: number;
    code: string;
    ipHash: string;
  }): Promise<VerifyTeamResult>;

  /** Mint a session after successful verification and editor identification. */
  createSession(input: CreateSessionInput): Promise<CreatedSession>;

  /** Resolve a session cookie to everything the team may see. */
  resolveSession(token: string): Promise<ParticipantView | null>;

  /** Sign out this browser. Does not affect other members. */
  endSession(token: string): Promise<void>;

  /**
   * Check an invite token without minting anything.
   *
   * Lets the invite page reject a dead link on load rather than after someone
   * has typed their name, and lets it say which team it is about to open.
   */
  resolveInviteTeam(token: string): Promise<{ teamId: string; groupNumber: number } | null>;

  /**
   * Legacy/demo path: resolve a one-per-team invite token and mint a session.
   * Kept so demo scenario links and any already-distributed invite still work.
   */
  redeemInviteToken(
    token: string,
    editor: { name: string; role: string | null },
  ): Promise<CreatedSession | null>;

  /** Autosave. Rejects a write whose version is behind the stored one. */
  saveDraft(token: string, draft: Record<string, unknown>, expectedVersion: number): Promise<SaveDraftResult>;

  /** Final Submit. Re-validates everything server-side, including the window. */
  finaliseSubmission(token: string, context: { ipHash: string | null }): Promise<FinaliseResult>;

  attachArtifact(
    token: string,
    artifact: Omit<SubmissionArtifact, 'id' | 'submissionId' | 'createdAt'>,
  ): Promise<SubmissionArtifact | null>;

  removeArtifact(token: string, artifactId: string): Promise<void>;

  /** Store demo credentials. Takes plaintext, stores only ciphertext. */
  storeCredentials(
    token: string,
    values: { username?: string; password?: string; loginInstructions?: string },
  ): Promise<void>;

  /** Participant-visible resources: guide, template, instructions. */
  listParticipantResources(cohortId: string): Promise<ResourceDocument[]>;

  /** Learner-safe activity, shown back to the team. */
  recordActivity(token: string, kind: TeamActivityKind, section?: string | null): Promise<void>;

  /**
   * Store a pitch deck: the bytes AND the record of them.
   *
   * One method rather than two, because the two must not be able to disagree.
   * The previous code wrote only the metadata row — so a team saw "uploaded",
   * the database reported 706 KB of PDF, and Supabase Storage held nothing at
   * all. Nobody would have discovered that until judges opened the bucket after
   * the deadline.
   *
   * Implementations must persist the bytes FIRST and record the artifact only
   * if that succeeded. A missing row with a stored object wastes space; a row
   * with no object destroys a submission.
   */
  uploadDeck(
    token: string,
    input: {
      bytes: Uint8Array;
      originalFilename: string;
      mimeType: string;
    },
  ): Promise<SubmissionArtifact | null>;

  /**
   * Authorise one browser upload, to one path this server chose.
   *
   * The bytes do not pass through the application. A serverless request body
   * tops out around 4.5 MB and a pitch deck may be 25, so routing the file
   * through a function cannot work — but the authorisation still must not move
   * to the browser. This returns a URL that can write to exactly one object and
   * nothing else, and the caller never learns a bucket name it could change or
   * a key it could reuse.
   *
   * The path is deliberately new on every attempt rather than the deck's final
   * name: a replacement that fails halfway must leave the previous deck intact,
   * which is impossible if the new bytes are written over the old ones.
   */
  createDeckUploadTicket(
    token: string,
    input: { originalFilename: string; byteSize: number; mimeType: string },
  ): Promise<DeckUploadTicket>;

  /**
   * Take delivery of an upload, or refuse it.
   *
   * Checks the bucket rather than the browser: the object must exist, be the
   * size the bucket says it is, and begin with a PDF signature. Only then is an
   * artifact row written. This is the F-7 guarantee — a recorded deck means
   * stored bytes — and it is the reason the two steps exist at all.
   */
  confirmDeckUpload(
    token: string,
    input: { storagePath: string; originalFilename: string },
  ): Promise<DeckUploadResult>;

  /** Receipt data for a locked submission. Null while still a draft. */
  getReceipt(token: string): Promise<ParticipantReceipt | null>;
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

  /**
   * The cohort the common /submit URL belongs to.
   *
   * One URL serves whichever cohort is currently running, so the learner entry
   * page needs to resolve it without being told which one. Prefers an open
   * cohort, then a paused one, then the most recently created non-archived one,
   * so the page still explains itself between cohorts.
   */
  findActiveCohort(): Promise<Cohort | null>;

  /**
   * Every cohort learners can currently sign in to.
   *
   * Normally zero or one. More than one is an operational fault the admin
   * surface must surface rather than resolve — see `checkCohortExclusivity`.
   */
  listLearnerFacingCohorts(): Promise<Cohort[]>;
  createCohort(input: Omit<Cohort, 'id' | 'createdAt' | 'updatedAt' | 'finalisedAt'>): Promise<Cohort>;
  updateCohort(id: string, patch: Partial<Cohort>): Promise<Cohort>;
  setCohortStatus(id: string, status: CohortStatus): Promise<Cohort>;

  /** Manual close. Records when and that it was an admin action. */
  closeSubmissions(id: string, closureType: 'manual' | 'deadline'): Promise<Cohort>;

  /**
   * Reopen. After the official deadline this requires an extension, or the
   * cohort would read as open while rejecting every write.
   */
  reopenSubmissions(
    id: string,
    input: { reason: string; newDeadline?: Date | null; acceptingUntil?: Date | null },
  ): Promise<Cohort>;

  /**
   * Close any cohort whose deadline has passed. A convenience for a scheduler —
   * acceptance never depends on this having run.
   */
  reconcileDeadlines(now?: Date): Promise<{ closed: string[] }>;

  /**
   * What a cohort holds. Read before offering deletion, never after.
   */
  getCohortDependencies(id: string): Promise<CohortDependencies>;

  /**
   * Archive. The normal way to retire a cohort — preserves everything and
   * removes it from operational views.
   */
  archiveCohort(id: string, actor: string): Promise<Cohort>;

  /**
   * Permanently delete a cohort created by mistake.
   *
   * Refuses when the cohort holds meaningful data, regardless of what the caller
   * passes — the confirmation phrase is a second gate, not the only one.
   */
  deleteCohortPermanently(
    id: string,
    input: { confirmationPhrase: string; actor: string },
  ): Promise<{ deleted: true; removed: { label: string; count: number }[] }>;

  /** Approve a cohort's expanded idea definitions for real judging. */
  approveIdeaDefinition(ideaId: string, actor: string): Promise<CohortIdea>;

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

  /**
   * Import the learner allocation sheet.
   *
   * The real Outskill sheet lists every learner against a group number. This
   * turns that into teams and members, and is safe to run more than once: the
   * corrected sheet always arrives after the first one.
   *
   * Re-running adds learners and refreshes contact links. It never deletes a
   * learner who has disappeared from the sheet — a row dropped by accident and
   * a learner who genuinely left look identical here, so departures are
   * reported for a human to act on rather than applied silently.
   */
  importLearnerAllocation(
    cohortId: string,
    groups: readonly LearnerAllocationGroup[],
  ): Promise<LearnerAllocationResult>;
  generateInvite(teamId: string): Promise<{ invite: TeamInvite; token: string }>;
  revokeInvite(teamId: string): Promise<void>;

  /**
   * Access codes.
   *
   * Plaintext is returned exactly once, at generation. There is deliberately no
   * method to read a code back — only the Argon2id hash is stored.
   */
  generateAccessCodes(input: {
    cohortId: string;
    /** Only teams without a live code, unless regeneration is explicit. */
    teamIds?: string[];
    regenerate: boolean;
  }): Promise<GeneratedAccessCodeRow[]>;

  listAccessCodeStatus(cohortId: string): Promise<AccessCodeStatus[]>;
  revokeAccessCode(teamId: string): Promise<void>;
  restoreAccessCode(teamId: string): Promise<void>;
  /** Clear a verification lockout for a team that locked itself out. */
  clearVerificationLockout(cohortId: string, groupNumber: number): Promise<void>;
}

/** A one-object, short-lived permission to write, minted per attempt. */
export interface DeckUploadTicket {
  ok: boolean;
  /** Absent when refused. */
  uploadUrl?: string;
  uploadToken?: string;
  /** Where the server decided this upload goes. Echoed back on confirmation. */
  storagePath?: string;
  maxBytes?: number;
  error?: string;
}

export interface DeckUploadResult {
  ok: boolean;
  artifact?: SubmissionArtifact;
  error?: string;
}

/** Returned once, at generation. The plaintext is never stored. */
export interface GeneratedAccessCodeRow {
  teamId: string;
  groupNumber: number;
  leadName: string | null;
  leadEmail: string | null;
  /**
   * Where this code has to be sent.
   *
   * Distribution is manual (ADR-024), so the operator needs the destination
   * next to the code. Looking each one up separately across 100 groups is how
   * a code ends up in the wrong chat.
   */
  whatsappLink: string | null;
  memberCount: number;
  /** Formatted for reading aloud, e.g. ABCD-EFGH-JKMN. */
  code: string;
  regenerated: boolean;
}

export interface AccessCodeStatus {
  teamId: string;
  groupNumber: number;
  leadName: string | null;
  leadEmail: string | null;
  whatsappLink: string | null;
  hasCode: boolean;
  version: number;
  createdAt: Date | null;
  revokedAt: Date | null;
  lastVerifiedAt: Date | null;
  verifyCount: number;
  activeSessions: number;
  lockedUntil: Date | null;
}

/** One group from the allocation sheet, already parsed and validated. */
export interface LearnerAllocationGroup {
  groupNumber: number;
  /** Operational contact only. Null leaves any existing link untouched. */
  whatsappLink: string | null;
  learners: { name: string; email: string }[];
}

export interface LearnerAllocationResult {
  teamsCreated: number;
  teamsMatched: number;
  learnersAdded: number;
  learnersUpdated: number;
  learnersUnchanged: number;
  whatsappLinksSet: number;
  /**
   * Learners in the cohort who were absent from this sheet.
   *
   * Reported, never removed. Deciding they left would destroy real learner
   * records on the strength of a spreadsheet edit.
   */
  departed: { teamId: string; groupNumber: number; name: string; email: string }[];
  /** Groups that failed. Each is independent, so the rest still import. */
  failed: { groupNumber: number; reason: string }[];
}

export interface TeamImportResult {
  created: Team[];
  skipped: { row: number; groupNumber: number | null; reason: string }[];
  invites: { teamId: string; groupNumber: number; leadEmail: string | null; token: string }[];
}

export interface SubmissionStore {
  listSubmissions(
    cohortId: string,
    filter?: { status?: SubmissionStatus; stage?: AssessmentStage; search?: string },
  ): Promise<SubmissionListItem[]>;
  getSubmission(id: string): Promise<Submission | null>;
  /** Locate a submission from the public receipt ID a team quotes. */
  findByReceiptId(receiptId: string): Promise<Submission | null>;
  listTeamActivity(submissionId: string): Promise<TeamActivity[]>;
  /** Revoke every participant session for a team. */
  revokeTeamSessions(teamId: string): Promise<number>;
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

export interface DemoInvite {
  teamId: string;
  groupNumber: number;
  token: string;
}

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

  /**
   * Demo-mode capabilities, declared on the interface rather than discovered
   * with `instanceof`.
   *
   * The store instance is cached across module reloads, so a class-identity
   * check compares against a stale constructor and silently fails — which is
   * exactly how the demo invite links disappeared. Callers must feature-detect
   * these methods instead.
   */
  getDemoInviteToken?(teamId: string): string | null;
  listDemoInvites?(): DemoInvite[];
  /**
   * The fixture team's access code in plaintext.
   *
   * Only the memory driver can answer this, and only because it generated the
   * fixture codes in-process. Real codes are stored as Argon2id hashes and are
   * not retrievable by anyone, including an admin.
   */
  getDemoAccessCode?(groupNumber: number): string;
  /** Fixture seeding is async; await this before reading demo values. */
  whenReady?(): Promise<void>;
}

type DemoMethods = 'getDemoInviteToken' | 'listDemoInvites' | 'getDemoAccessCode' | 'whenReady';
export type DemoCapableStore = DataStore & Required<Pick<DataStore, DemoMethods>>;

/**
 * Feature-detect the demo capability. Survives module reloading because it
 * asks what the object can do, not what class it came from.
 */
export function asDemoStore(store: DataStore): DemoCapableStore | null {
  if (store.driver !== 'memory') return null;
  const methods: DemoMethods[] = [
    'getDemoInviteToken',
    'listDemoInvites',
    'getDemoAccessCode',
    'whenReady',
  ];
  if (methods.some((method) => typeof store[method] !== 'function')) return null;
  return store as DemoCapableStore;
}
