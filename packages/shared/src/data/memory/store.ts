/**
 * Memory driver — the demo-mode implementation of `DataStore`.
 *
 * Satisfies the same interfaces as the postgres driver, including lease-based
 * job claiming, so behaviour that depends on queue semantics can be tested
 * without a database.
 */

import { RUBRIC_CATEGORIES, RUBRIC_VERSION, totalScore, weightedScore } from '../../rubric/index.js';
import {
  deserialiseEnvelope,
  decryptSecret,
  encryptSecret,
  generateInviteToken,
  hashInviteToken,
  serialiseEnvelope,
} from '../../security/crypto.js';
import { compareForRanking, type RankableSubmission } from '../../domain/ranking.js';
import { canParticipantEdit, type AssessmentStage, type CohortStatus, type SubmissionStatus } from '../../domain/status.js';
import { isSubmissionLate } from '../../domain/deadline.js';
import { generateReceiptId, newId } from '../../domain/ids.js';
import { assertDisqualificationAllowed } from '../../domain/disqualification.js';
import type { RubricCategoryKey } from '../../rubric/index.js';
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
} from '../types.js';
import type {
  AdminAuthStore,
  AssessmentStore,
  AuditStore,
  CohortStore,
  DataStore,
  ParticipantStore,
  QueueStats,
  RankedListItem,
  RankingStore,
  ResourceStore,
  SettingsStore,
  SubmissionListItem,
  SubmissionStore,
  TeamImportResult,
  TeamStore,
} from '../store.js';
import { createEmptyDatabase, seedDemoDatabase, type MemoryDatabase } from './database.js';

const DEMO_KEY = Buffer.alloc(32, 7);
const clone = <T>(value: T): T => structuredClone(value);

export class MemoryDataStore implements DataStore {
  readonly driver = 'memory' as const;
  private db: MemoryDatabase;

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

  constructor(options: { seed?: boolean } = {}) {
    this.db = createEmptyDatabase();
    if (options.seed !== false) seedDemoDatabase(this.db);

    this.participant = this.buildParticipantStore();
    this.adminAuth = this.buildAdminAuthStore();
    this.cohorts = this.buildCohortStore();
    this.teams = this.buildTeamStore();
    this.submissions = this.buildSubmissionStore();
    this.assessment = this.buildAssessmentStore();
    this.ranking = this.buildRankingStore();
    this.resources = this.buildResourceStore();
    this.audit = this.buildAuditStore();
    this.settings = this.buildSettingsStore();
  }

  async reset(): Promise<void> {
    this.db = createEmptyDatabase();
    seedDemoDatabase(this.db);
  }

  /** Demo-only helper: the working invite link for a team. */
  getDemoInviteToken(teamId: string): string | null {
    return this.db.demoInviteTokens.get(teamId) ?? null;
  }

  listDemoInvites(): { teamId: string; groupNumber: number; token: string }[] {
    return [...this.db.demoInviteTokens.entries()].map(([teamId, token]) => ({
      teamId,
      groupNumber: this.db.teams.find((t) => t.id === teamId)?.groupNumber ?? 0,
      token,
    }));
  }

  // ------------------------------------------------------------------------
  // Participant
  // ------------------------------------------------------------------------

  private buildParticipantStore(): ParticipantStore {
    const db = () => this.db;

    return {
      resolveInvite: async (token: string): Promise<ParticipantView | null> => {
        const hash = hashInviteToken(token);
        const invite = db().teamInvites.find((i) => i.tokenHash === hash);
        // Unknown, revoked, and expired all return null — the caller must not
        // be able to tell which, or it confirms a token exists.
        if (!invite || invite.revokedAt) return null;
        if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return null;

        const team = db().teams.find((t) => t.id === invite.teamId);
        if (!team) return null;
        const cohort = db().cohorts.find((c) => c.id === team.cohortId);
        if (!cohort) return null;

        let submission = db().submissions.find((s) => s.teamId === team.id && s.cohortId === cohort.id);
        if (!submission) {
          submission = this.createEmptySubmission(cohort.id, team.id);
          db().submissions.push(submission);
        }

        invite.lastAccessedAt = new Date();
        invite.accessCount += 1;

        return clone({
          cohort: {
            id: cohort.id,
            name: cohort.name,
            code: cohort.code,
            description: cohort.description,
            timezone: cohort.timezone,
            day12StartAt: cohort.day12StartAt,
            day13DeadlineAt: cohort.day13DeadlineAt,
            submissionInstructions: cohort.submissionInstructions,
            status: cohort.status,
          },
          team: {
            id: team.id,
            groupNumber: team.groupNumber,
            leadName: team.leadName,
            leadEmail: team.leadEmail,
            leadPhone: team.leadPhone,
          },
          members: db().teamMembers.filter((m) => m.teamId === team.id).sort((a, b) => a.displayOrder - b.displayOrder),
          submission,
          artifacts: db().artifacts.filter((a) => a.submissionId === submission.id),
          declarations: db().declarations.find((d) => d.submissionId === submission.id) ?? null,
          ideas: db()
            .ideas.filter((i) => i.cohortId === cohort.id && i.isActive)
            .sort((a, b) => a.displayOrder - b.displayOrder),
          hasStoredCredentials: db().credentials.some(
            (c) => c.submissionId === submission.id && !c.deletedAt,
          ),
          canEdit: canParticipantEdit(cohort.status, submission.status),
        });
      },

      saveDraft: async (submissionId, draft) => {
        const submission = this.requireSubmission(submissionId);
        this.assertEditable(submission);
        submission.draftPayload = clone(draft);
        submission.draftUpdatedAt = new Date();
        submission.updatedAt = new Date();
        this.promoteDraftToColumns(submission);
        return clone(submission);
      },

      finaliseSubmission: async (submissionId, context) => {
        const submission = this.requireSubmission(submissionId);
        this.assertEditable(submission);
        const cohort = this.requireCohort(submission.cohortId);
        const team = this.requireTeam(submission.teamId);

        const now = new Date();
        submission.status = 'locked';
        submission.submittedAt = now;
        submission.lockedAt = now;
        submission.updatedAt = now;
        submission.isLate = isSubmissionLate(now, cohort.day13DeadlineAt);
        submission.receiptId ??= generateReceiptId(cohort.code, team.groupNumber);

        const declarations = this.db.declarations.find((d) => d.submissionId === submissionId);
        if (declarations) {
          declarations.acceptedAt = now;
          declarations.acceptedIpHash = context.ipHash;
        }

        this.db.events.push({
          id: newId(),
          submissionId,
          eventType: 'final_submitted',
          actorType: 'participant',
          detail: { receiptId: submission.receiptId },
          createdAt: now,
        });

        return { submission: clone(submission), receiptId: submission.receiptId };
      },

      attachArtifact: async (submissionId, artifact) => {
        const submission = this.requireSubmission(submissionId);
        this.assertEditable(submission);
        // One deck and one demo video per submission — replace rather than append.
        if (artifact.kind === 'deck_pdf' || artifact.kind === 'demo_video') {
          this.db.artifacts = this.db.artifacts.filter(
            (a) => !(a.submissionId === submissionId && a.kind === artifact.kind),
          );
        }
        const record: SubmissionArtifact = {
          ...artifact,
          id: newId(),
          submissionId,
          createdAt: new Date(),
        };
        this.db.artifacts.push(record);
        return clone(record);
      },

      removeArtifact: async (submissionId, artifactId) => {
        const submission = this.requireSubmission(submissionId);
        this.assertEditable(submission);
        this.db.artifacts = this.db.artifacts.filter(
          (a) => !(a.id === artifactId && a.submissionId === submissionId),
        );
      },

      storeCredentials: async (submissionId, values) => {
        const submission = this.requireSubmission(submissionId);
        this.assertEditable(submission);
        const existing = this.db.credentials.find((c) => c.submissionId === submissionId);
        const enc = (value: string | undefined) =>
          value && value.length > 0 ? serialiseEnvelope(encryptSecret(value, DEMO_KEY)) : null;

        const record: SubmissionCredentials = existing ?? {
          id: newId(),
          submissionId,
          usernameCiphertext: null,
          passwordCiphertext: null,
          loginInstructionsCiphertext: null,
          keyVersion: 1,
          deletedAt: null,
          lastRevealedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        record.usernameCiphertext = enc(values.username);
        record.passwordCiphertext = enc(values.password);
        record.loginInstructionsCiphertext = enc(values.loginInstructions);
        record.updatedAt = new Date();
        record.deletedAt = null;
        if (!existing) this.db.credentials.push(record);
      },

      listParticipantResources: async (cohortId) =>
        clone(
          this.db.resources
            .filter((r) => r.isParticipantVisible && (r.cohortId === cohortId || r.cohortId === null))
            .sort((a, b) => a.displayOrder - b.displayOrder),
        ),

      recordEvent: async (submissionId, event) => {
        this.db.events.push({
          id: newId(),
          submissionId,
          eventType: event.eventType,
          actorType: 'participant',
          detail: event.detail ?? {},
          createdAt: new Date(),
        });
      },
    };
  }

  // ------------------------------------------------------------------------
  // Admin auth
  // ------------------------------------------------------------------------

  private buildAdminAuthStore(): AdminAuthStore {
    return {
      getAdminAccount: async () => (this.db.adminAccount ? clone(this.db.adminAccount) : null),

      createAdminAccount: async (username, passwordHash) => {
        if (this.db.adminAccount) {
          throw new Error('An admin account already exists. There is exactly one shared admin account.');
        }
        const account: AdminAccount = {
          id: newId(),
          username,
          passwordHash,
          passwordUpdatedAt: new Date(),
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.db.adminAccount = account;
        return clone(account);
      },

      updateAdminLockout: async (state) => {
        if (!this.db.adminAccount) return;
        this.db.adminAccount.failedAttempts = state.failedAttempts;
        this.db.adminAccount.lockedUntil = state.lockedUntil;
        this.db.adminAccount.updatedAt = new Date();
      },

      recordSuccessfulLogin: async () => {
        if (!this.db.adminAccount) return;
        this.db.adminAccount.failedAttempts = 0;
        this.db.adminAccount.lockedUntil = null;
        this.db.adminAccount.lastLoginAt = new Date();
        this.db.adminAccount.updatedAt = new Date();
      },

      rotateCredentials: async ({ username, passwordHash }) => {
        if (!this.db.adminAccount) throw new Error('No admin account exists.');
        if (username) this.db.adminAccount.username = username;
        if (passwordHash) {
          this.db.adminAccount.passwordHash = passwordHash;
          this.db.adminAccount.passwordUpdatedAt = new Date();
        }
        this.db.adminAccount.updatedAt = new Date();
      },

      createSession: async (input) => {
        const session: AdminSession = {
          id: newId(),
          adminId: this.db.adminAccount?.id ?? 'unknown',
          sessionTokenHash: input.sessionTokenHash,
          csrfToken: input.csrfToken,
          issuedAt: new Date(),
          expiresAt: input.expiresAt,
          rotatedFrom: input.rotatedFrom,
          ipHash: input.ipHash,
          userAgentHash: input.userAgentHash,
          revokedAt: null,
        };
        this.db.adminSessions.push(session);
        return clone(session);
      },

      getSessionByHash: async (hash) => {
        const session = this.db.adminSessions.find((s) => s.sessionTokenHash === hash);
        if (!session || session.revokedAt) return null;
        if (session.expiresAt.getTime() < Date.now()) return null;
        return clone(session);
      },

      revokeSession: async (sessionId) => {
        const session = this.db.adminSessions.find((s) => s.id === sessionId);
        if (session) session.revokedAt = new Date();
      },

      revokeAllSessions: async () => {
        const now = new Date();
        this.db.adminSessions.forEach((s) => {
          s.revokedAt ??= now;
        });
      },
    };
  }

  // ------------------------------------------------------------------------
  // Cohorts and ideas
  // ------------------------------------------------------------------------

  private buildCohortStore(): CohortStore {
    return {
      listCohorts: async () => clone(this.db.cohorts).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      getCohort: async (id) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        return cohort ? clone(cohort) : null;
      },
      getCohortByCode: async (code) => {
        const cohort = this.db.cohorts.find((c) => c.code.toLowerCase() === code.toLowerCase());
        return cohort ? clone(cohort) : null;
      },
      createCohort: async (input) => {
        if (this.db.cohorts.some((c) => c.code.toLowerCase() === input.code.toLowerCase())) {
          throw new Error(`A cohort with code "${input.code}" already exists.`);
        }
        const cohort: Cohort = {
          ...input,
          id: newId(),
          finalisedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.db.cohorts.push(cohort);
        return clone(cohort);
      },
      updateCohort: async (id, patch) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);
        Object.assign(cohort, patch, { id: cohort.id, updatedAt: new Date() });
        return clone(cohort);
      },
      setCohortStatus: async (id, status: CohortStatus) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);
        cohort.status = status;
        if (status === 'finalised') cohort.finalisedAt = new Date();
        cohort.updatedAt = new Date();
        return clone(cohort);
      },

      listIdeas: async (cohortId, options) =>
        clone(
          this.db.ideas
            .filter((i) => i.cohortId === cohortId && (options?.includeInactive || i.isActive))
            .sort((a, b) => a.displayOrder - b.displayOrder),
        ),
      getIdea: async (id) => {
        const idea = this.db.ideas.find((i) => i.id === id);
        return idea ? clone(idea) : null;
      },
      createIdea: async (input) => {
        const idea: CohortIdea = { ...input, id: newId(), createdAt: new Date(), updatedAt: new Date() };
        this.db.ideas.push(idea);
        return clone(idea);
      },
      updateIdea: async (id, patch) => {
        const idea = this.db.ideas.find((i) => i.id === id);
        if (!idea) throw new Error(`Idea ${id} not found.`);
        Object.assign(idea, patch, { id: idea.id, updatedAt: new Date() });
        return clone(idea);
      },
      deleteIdea: async (id) => {
        // Soft-delete: a past submission must keep resolving its idea.
        const idea = this.db.ideas.find((i) => i.id === id);
        if (idea) idea.isActive = false;
      },
      cloneIdeas: async (fromCohortId, toCohortId) => {
        const source = this.db.ideas.filter((i) => i.cohortId === fromCohortId);
        const copies = source.map((idea) => ({
          ...clone(idea),
          id: newId(),
          cohortId: toCohortId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        this.db.ideas.push(...copies);
        return clone(copies);
      },
    };
  }

  // ------------------------------------------------------------------------
  // Teams
  // ------------------------------------------------------------------------

  private buildTeamStore(): TeamStore {
    return {
      listTeams: async (cohortId) =>
        clone(
          this.db.teams
            .filter((t) => t.cohortId === cohortId)
            .sort((a, b) => a.groupNumber - b.groupNumber)
            .map((team) => ({
              ...team,
              members: this.db.teamMembers.filter((m) => m.teamId === team.id),
              invite: this.db.teamInvites.find((i) => i.teamId === team.id) ?? null,
            })),
        ),

      getTeam: async (id) => {
        const team = this.db.teams.find((t) => t.id === id);
        return team ? clone(team) : null;
      },

      importTeams: async (cohortId, rows): Promise<TeamImportResult> => {
        const created: Team[] = [];
        const skipped: TeamImportResult['skipped'] = [];
        const invites: TeamImportResult['invites'] = [];

        rows.forEach((row, index) => {
          const rowNumber = index + 1;
          if (!Number.isInteger(row.groupNumber) || row.groupNumber < 1 || row.groupNumber > 999) {
            skipped.push({ row: rowNumber, groupNumber: null, reason: 'Group number must be a whole number between 1 and 999.' });
            return;
          }
          if (this.db.teams.some((t) => t.cohortId === cohortId && t.groupNumber === row.groupNumber)) {
            skipped.push({
              row: rowNumber,
              groupNumber: row.groupNumber,
              reason: `Group ${row.groupNumber} already exists in this cohort.`,
            });
            return;
          }
          if (!row.leadEmail.includes('@')) {
            skipped.push({ row: rowNumber, groupNumber: row.groupNumber, reason: 'Lead email is not a valid address.' });
            return;
          }

          const team: Team = {
            id: newId(),
            cohortId,
            groupNumber: row.groupNumber,
            leadName: row.leadName,
            leadEmail: row.leadEmail,
            leadPhone: row.leadPhone,
            status: 'active',
            importedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          this.db.teams.push(team);
          created.push(team);

          const token = generateInviteToken();
          this.db.teamInvites.push({
            id: newId(),
            teamId: team.id,
            tokenHash: token.tokenHash,
            tokenPrefix: token.tokenPrefix,
            issuedAt: new Date(),
            expiresAt: null,
            revokedAt: null,
            lastAccessedAt: null,
            accessCount: 0,
          });
          this.db.demoInviteTokens.set(team.id, token.token);
          invites.push({ teamId: team.id, groupNumber: team.groupNumber, leadEmail: team.leadEmail, token: token.token });
        });

        return { created: clone(created), skipped, invites };
      },

      generateInvite: async (teamId) => {
        const existing = this.db.teamInvites.filter((i) => i.teamId === teamId);
        existing.forEach((i) => {
          i.revokedAt ??= new Date();
        });
        const token = generateInviteToken();
        const invite: TeamInvite = {
          id: newId(),
          teamId,
          tokenHash: token.tokenHash,
          tokenPrefix: token.tokenPrefix,
          issuedAt: new Date(),
          expiresAt: null,
          revokedAt: null,
          lastAccessedAt: null,
          accessCount: 0,
        };
        this.db.teamInvites.push(invite);
        this.db.demoInviteTokens.set(teamId, token.token);
        return { invite: clone(invite), token: token.token };
      },

      revokeInvite: async (teamId) => {
        this.db.teamInvites
          .filter((i) => i.teamId === teamId && !i.revokedAt)
          .forEach((i) => {
            i.revokedAt = new Date();
          });
        this.db.demoInviteTokens.delete(teamId);
      },
    };
  }

  // ------------------------------------------------------------------------
  // Submissions
  // ------------------------------------------------------------------------

  private buildSubmissionStore(): SubmissionStore {
    return {
      listSubmissions: async (cohortId, filter) => {
        const items: SubmissionListItem[] = this.db.submissions
          .filter((s) => s.cohortId === cohortId)
          .map((submission) => this.buildListItem(submission))
          .filter((item) => {
            if (filter?.status && item.submission.status !== filter.status) return false;
            if (filter?.stage && item.stage !== filter.stage) return false;
            if (filter?.search) {
              const needle = filter.search.toLowerCase();
              const haystack = `${item.team.groupNumber} ${item.submission.productName ?? ''} ${item.team.leadEmail}`.toLowerCase();
              if (!haystack.includes(needle)) return false;
            }
            return true;
          })
          .sort((a, b) => a.team.groupNumber - b.team.groupNumber);
        return clone(items);
      },

      getSubmission: async (id) => {
        const submission = this.db.submissions.find((s) => s.id === id);
        return submission ? clone(submission) : null;
      },

      getSubmissionDetail: async (id) => this.buildSubmissionDetail(id),

      reopenSubmission: async (id, reason) => {
        const submission = this.requireSubmission(id);
        submission.status = 'reopened';
        submission.reopenedAt = new Date();
        submission.reopenedReason = reason;
        submission.lockedAt = null;
        submission.updatedAt = new Date();
        this.db.events.push({
          id: newId(),
          submissionId: id,
          eventType: 'reopened_by_admin',
          actorType: 'shared-admin',
          detail: { reason },
          createdAt: new Date(),
        });
        return clone(submission);
      },

      lockSubmission: async (id) => {
        const submission = this.requireSubmission(id);
        submission.status = 'locked';
        submission.lockedAt = new Date();
        submission.updatedAt = new Date();
        return clone(submission);
      },

      setLateException: async (id, granted, reason) => {
        const submission = this.requireSubmission(id);
        submission.hasLateException = granted;
        submission.updatedAt = new Date();
        this.db.events.push({
          id: newId(),
          submissionId: id,
          eventType: granted ? 'late_exception_granted' : 'late_exception_revoked',
          actorType: 'shared-admin',
          detail: { reason },
          createdAt: new Date(),
        });
        return clone(submission);
      },

      getCredentials: async (submissionId) => {
        const record = this.db.credentials.find((c) => c.submissionId === submissionId && !c.deletedAt);
        return record ? clone(record) : null;
      },

      revealCredentials: async (submissionId) => {
        const record = this.db.credentials.find((c) => c.submissionId === submissionId && !c.deletedAt);
        if (!record) return null;
        record.lastRevealedAt = new Date();
        const dec = (value: string | null) =>
          value ? decryptSecret(deserialiseEnvelope(value), DEMO_KEY) : '';
        return {
          username: dec(record.usernameCiphertext),
          password: dec(record.passwordCiphertext),
          loginInstructions: dec(record.loginInstructionsCiphertext),
        };
      },

      deleteCredentials: async (submissionId) => {
        const record = this.db.credentials.find((c) => c.submissionId === submissionId);
        if (!record) return;
        record.usernameCiphertext = null;
        record.passwordCiphertext = null;
        record.loginInstructionsCiphertext = null;
        record.deletedAt = new Date();
      },

      listArtifacts: async (submissionId) =>
        clone(this.db.artifacts.filter((a) => a.submissionId === submissionId)),

      getDeclarations: async (submissionId) => {
        const record = this.db.declarations.find((d) => d.submissionId === submissionId);
        return record ? clone(record) : null;
      },

      listEvents: async (submissionId) =>
        clone(
          this.db.events
            .filter((e) => e.submissionId === submissionId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        ),
    };
  }

  // ------------------------------------------------------------------------
  // Assessment
  // ------------------------------------------------------------------------

  private buildAssessmentStore(): AssessmentStore {
    return {
      enqueueCohort: async (cohortId) => {
        let queued = 0;
        let skipped = 0;
        for (const submission of this.db.submissions.filter((s) => s.cohortId === cohortId)) {
          const isFinal = submission.status === 'submitted' || submission.status === 'locked';
          if (!isFinal) {
            skipped += 1;
            continue;
          }
          if (this.db.jobs.some((j) => j.submissionId === submission.id)) {
            skipped += 1;
            continue;
          }
          this.db.jobs.push(this.newJob(submission));
          queued += 1;
        }
        return { queued, skipped };
      },

      enqueueSubmission: async (submissionId) => {
        const submission = this.requireSubmission(submissionId);
        const existing = this.db.jobs.find((j) => j.submissionId === submissionId);
        if (existing) {
          existing.stage = 'queued';
          existing.attemptCount = 0;
          existing.lastError = null;
          existing.completedAt = null;
          existing.claimedBy = null;
          existing.leaseExpiresAt = null;
          existing.nextAttemptAt = null;
          existing.updatedAt = new Date();
          return clone(existing);
        }
        const job = this.newJob(submission);
        this.db.jobs.push(job);
        return clone(job);
      },

      getJob: async (jobId) => {
        const job = this.db.jobs.find((j) => j.id === jobId);
        return job ? clone(job) : null;
      },

      getJobBySubmission: async (submissionId) => {
        const job = this.db.jobs.find((j) => j.submissionId === submissionId);
        return job ? clone(job) : null;
      },

      listJobs: async (cohortId, filter) =>
        clone(
          this.db.jobs.filter((j) => j.cohortId === cohortId && (!filter?.stage || j.stage === filter.stage)),
        ),

      /**
       * Lease-based claim, mirroring FOR UPDATE SKIP LOCKED: a job already held
       * by a live lease is invisible to another worker.
       */
      claimJobs: async ({ workerId, limit, leaseSeconds }) => {
        const now = Date.now();
        const claimable = this.db.jobs
          .filter((job) => {
            if (!CLAIMABLE_STAGES.includes(job.stage)) return false;
            if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > now) return false;
            if (job.nextAttemptAt && job.nextAttemptAt.getTime() > now) return false;
            return true;
          })
          .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit);

        claimable.forEach((job) => {
          job.claimedBy = workerId;
          job.claimedAt = new Date();
          job.leaseExpiresAt = new Date(now + leaseSeconds * 1000);
          job.heartbeatAt = new Date();
          job.startedAt ??= new Date();
          job.updatedAt = new Date();
        });

        return clone(claimable);
      },

      heartbeat: async (jobId, workerId) => {
        const job = this.db.jobs.find((j) => j.id === jobId && j.claimedBy === workerId);
        if (!job) return;
        job.heartbeatAt = new Date();
        job.leaseExpiresAt = new Date(Date.now() + 900_000);
      },

      advanceStage: async (jobId, stage, error) => {
        const job = this.db.jobs.find((j) => j.id === jobId);
        if (!job) throw new Error(`Job ${jobId} not found.`);
        job.stage = stage;
        job.lastError = error ?? null;
        job.updatedAt = new Date();
        if (stage === 'completed' || stage === 'failed' || stage === 'disqualified') {
          job.completedAt = new Date();
          job.claimedBy = null;
          job.leaseExpiresAt = null;
        }
        return clone(job);
      },

      releaseJob: async (jobId, options) => {
        const job = this.db.jobs.find((j) => j.id === jobId);
        if (!job) throw new Error(`Job ${jobId} not found.`);
        job.claimedBy = null;
        job.leaseExpiresAt = null;
        job.attemptCount += 1;
        job.lastError = options.error ?? job.lastError;
        job.nextAttemptAt = options.retryInMs ? new Date(Date.now() + options.retryInMs) : null;
        if (job.attemptCount >= job.maxAttempts && options.error) job.stage = 'failed';
        job.updatedAt = new Date();
        return clone(job);
      },

      reclaimExpiredLeases: async () => {
        const now = Date.now();
        let reclaimed = 0;
        for (const job of this.db.jobs) {
          if (job.claimedBy && job.leaseExpiresAt && job.leaseExpiresAt.getTime() < now) {
            job.claimedBy = null;
            job.leaseExpiresAt = null;
            job.lastError = 'Lease expired — worker did not heartbeat. Job reclaimed.';
            reclaimed += 1;
          }
        }
        return reclaimed;
      },

      recordPreflight: async (jobId, checks) => {
        checks.forEach((check) => {
          this.db.preflight.push({ ...clone(check), id: newId(), jobId });
        });
      },

      listPreflight: async (jobId) =>
        clone(
          this.db.preflight
            .filter((p) => p.jobId === jobId)
            .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime()),
        ),

      saveArtifactAnalysis: async (analysis) => {
        this.db.artifactAnalyses = this.db.artifactAnalyses.filter((a) => a.jobId !== analysis.jobId);
        const record: ArtifactAnalysis = { ...clone(analysis), id: newId(), createdAt: new Date() };
        this.db.artifactAnalyses.push(record);
        return clone(record);
      },

      saveTestPlan: async (plan, steps) => {
        this.db.testPlans = this.db.testPlans.filter((p) => p.jobId !== plan.jobId);
        const record: TestPlan = { ...clone(plan), id: newId(), createdAt: new Date() };
        this.db.testPlans.push(record);
        this.db.testPlanSteps = this.db.testPlanSteps.filter((s) => s.testPlanId !== record.id);
        steps.forEach((step) => {
          this.db.testPlanSteps.push({ ...clone(step), id: newId(), testPlanId: record.id });
        });
        return clone(record);
      },

      getTestPlan: async (jobId) => {
        const plan = this.db.testPlans.find((p) => p.jobId === jobId);
        if (!plan) return null;
        return clone({
          ...plan,
          steps: this.db.testPlanSteps
            .filter((s) => s.testPlanId === plan.id)
            .sort((a, b) => a.stepIndex - b.stepIndex),
        });
      },

      saveBrowserRun: async (run, steps) => {
        const record: BrowserTestRun = { ...clone(run), id: newId() };
        this.db.browserRuns.push(record);
        steps.forEach((step) => {
          this.db.browserSteps.push({ ...clone(step), id: newId(), runId: record.id });
        });
        return clone(record);
      },

      listBrowserRuns: async (jobId) =>
        clone(
          this.db.browserRuns
            .filter((r) => r.jobId === jobId)
            .map((run) => ({
              ...run,
              steps: this.db.browserSteps
                .filter((s) => s.runId === run.id)
                .sort((a, b) => a.stepIndex - b.stepIndex),
            })),
        ),

      saveEvidence: async (jobId, evidence) => {
        evidence.forEach((item) => {
          this.db.evidence.push({ ...clone(item), id: newId(), jobId, createdAt: new Date() });
        });
      },

      listEvidence: async (jobId) => clone(this.db.evidence.filter((e) => e.jobId === jobId)),

      saveScores: async (jobId, scores) => {
        this.db.scores = this.db.scores.filter((s) => s.jobId !== jobId);
        scores.forEach((score) => {
          this.db.scores.push({
            ...clone(score),
            id: newId(),
            jobId,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      },

      listScores: async (jobId) =>
        clone(
          this.db.scores
            .filter((s) => s.jobId === jobId)
            .sort(
              (a, b) =>
                rubricOrder(a.categoryKey) - rubricOrder(b.categoryKey),
            ),
        ),

      overrideScore: async ({ jobId, categoryKey, rawScore, reason, actor }) => {
        const score = this.db.scores.find((s) => s.jobId === jobId && s.categoryKey === categoryKey);
        if (!score) throw new Error(`No score for category ${categoryKey} on job ${jobId}.`);
        if (!reason.trim()) throw new Error('An override requires a reason.');
        // Preserve the model's answer so machine-vs-human disagreement stays visible.
        score.originalRawScore ??= score.rawScore;
        score.rawScore = rawScore;
        score.weightedScore = weightedScore(categoryKey as RubricCategoryKey, rawScore);
        score.isOverridden = true;
        score.overrideReason = reason;
        score.overriddenBy = actor;
        score.overriddenAt = new Date();
        score.updatedAt = new Date();
        this.recalculateSummary(jobId);
        return clone(score);
      },

      saveSummary: async (summary) => {
        this.db.summaries = this.db.summaries.filter((s) => s.jobId !== summary.jobId);
        const record: AssessmentSummary = { ...clone(summary), id: newId() };
        this.db.summaries.push(record);
        return clone(record);
      },

      getSummary: async (jobId) => {
        const summary = this.db.summaries.find((s) => s.jobId === jobId);
        return summary ? clone(summary) : null;
      },

      saveConsistencyReview: async (review) => {
        const record: ConsistencyReview = { ...clone(review), id: newId() };
        this.db.consistencyReviews.push(record);
        return clone(record);
      },

      saveFeedbackReport: async (report) => {
        this.db.feedbackReports = this.db.feedbackReports.filter((r) => r.submissionId !== report.submissionId);
        const record: FeedbackReport = { ...clone(report), id: newId() };
        this.db.feedbackReports.push(record);
        return clone(record);
      },

      getFeedbackReport: async (submissionId) => {
        const report = this.db.feedbackReports.find((r) => r.submissionId === submissionId);
        return report ? clone(report) : null;
      },

      raiseManualReview: async (flag) => {
        const record: ManualReviewFlag = { ...clone(flag), id: newId(), createdAt: new Date() };
        this.db.manualReviewFlags.push(record);
        return clone(record);
      },

      resolveManualReview: async (flagId, resolution) => {
        const flag = this.db.manualReviewFlags.find((f) => f.id === flagId);
        if (!flag) throw new Error(`Manual review flag ${flagId} not found.`);
        flag.status = resolution.status;
        flag.resolutionNote = resolution.note;
        flag.resolvedBy = resolution.actor;
        flag.resolvedAt = new Date();
      },

      listManualReviewFlags: async (cohortId) => {
        const submissionIds = new Set(
          this.db.submissions.filter((s) => s.cohortId === cohortId).map((s) => s.id),
        );
        return clone(
          this.db.manualReviewFlags
            .filter((f) => submissionIds.has(f.submissionId))
            .map((flag) => ({
              ...flag,
              groupNumber: this.groupNumberForSubmission(flag.submissionId),
            })),
        );
      },

      proposeDisqualification: async (input) => {
        assertDisqualificationAllowed(input.reasonCode, {
          proposedBySystem: input.proposedBy === 'system' || input.proposedBy === 'worker',
        });
        const record: Disqualification = {
          ...clone(input),
          id: newId(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.db.disqualifications.push(record);
        return clone(record);
      },

      confirmDisqualification: async (id, actor) => {
        const record = this.db.disqualifications.find((d) => d.id === id);
        if (!record) throw new Error(`Disqualification ${id} not found.`);
        record.status = 'confirmed';
        record.confirmedBy = actor;
        record.updatedAt = new Date();
        return clone(record);
      },

      reverseDisqualification: async (id, actor, reason) => {
        const record = this.db.disqualifications.find((d) => d.id === id);
        if (!record) throw new Error(`Disqualification ${id} not found.`);
        if (!reason.trim()) throw new Error('Reversing a disqualification requires a reason.');
        record.status = 'reversed';
        record.reversedBy = actor;
        record.reversedReason = reason;
        record.updatedAt = new Date();
        return clone(record);
      },

      listDisqualifications: async (cohortId) => {
        const submissionIds = new Set(
          this.db.submissions.filter((s) => s.cohortId === cohortId).map((s) => s.id),
        );
        return clone(this.db.disqualifications.filter((d) => submissionIds.has(d.submissionId)));
      },

      getQueueStats: async (cohortId) => this.computeQueueStats(cohortId),
    };
  }

  // ------------------------------------------------------------------------
  // Ranking
  // ------------------------------------------------------------------------

  private buildRankingStore(): RankingStore {
    return {
      generateSnapshot: async (cohortId, notes) => {
        const cohort = this.requireCohort(cohortId);
        const rankable = this.collectRankable(cohortId);
        const ordered = [...rankable].sort(compareForRanking);

        this.db.rankingSnapshots
          .filter((s) => s.cohortId === cohortId)
          .forEach((s) => {
            s.isCurrent = false;
          });

        const snapshot: RankingSnapshot = {
          id: newId(),
          cohortId,
          generatedAt: new Date(),
          rubricVersion: RUBRIC_VERSION,
          eligibleCount: ordered.length,
          shortlistTarget: cohort.shortlistTarget,
          isCurrent: true,
          notes: notes ?? null,
        };
        this.db.rankingSnapshots.push(snapshot);

        ordered.forEach((entry, index) => {
          this.db.rankingEntries.push({
            id: newId(),
            snapshotId: snapshot.id,
            submissionId: entry.submissionId,
            rank: index + 1,
            totalScore: totalScore(entry.scores),
            tiebreakVector: {
              total: totalScore(entry.scores),
              core_workflow: pick(entry, 'core_workflow'),
              stability: pick(entry, 'stability'),
              ai_usefulness: pick(entry, 'ai_usefulness'),
              learning_execution: pick(entry, 'learning_execution'),
              unresolvedRisks: entry.unresolvedRiskCount,
            },
            inShortlist: index < cohort.shortlistTarget,
            meanConfidence: entry.meanConfidence,
          });
        });

        return clone(snapshot);
      },

      getCurrentSnapshot: async (cohortId) => {
        const snapshot = this.db.rankingSnapshots.find((s) => s.cohortId === cohortId && s.isCurrent);
        if (!snapshot) return null;
        const entries: RankedListItem[] = this.db.rankingEntries
          .filter((e) => e.snapshotId === snapshot.id)
          .sort((a, b) => a.rank - b.rank)
          .map((entry) => {
            const submission = this.db.submissions.find((s) => s.id === entry.submissionId);
            const job = this.db.jobs.find((j) => j.submissionId === entry.submissionId);
            const summary = job ? this.db.summaries.find((s) => s.jobId === job.id) : undefined;
            return {
              entry,
              submissionId: entry.submissionId,
              groupNumber: this.groupNumberForSubmission(entry.submissionId),
              productName: submission?.productName ?? null,
              ideaTitle: this.db.ideas.find((i) => i.id === submission?.ideaId)?.title ?? null,
              lowConfidence: summary?.lowConfidence ?? false,
              hasOpenManualReview: this.db.manualReviewFlags.some(
                (f) => f.submissionId === entry.submissionId && f.status === 'open',
              ),
            };
          });
        return clone({ ...snapshot, entries });
      },

      listSnapshots: async (cohortId) =>
        clone(
          this.db.rankingSnapshots
            .filter((s) => s.cohortId === cohortId)
            .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime()),
        ),

      listFinalSelections: async (cohortId) =>
        clone(
          this.db.finalSelections
            .filter((s) => s.cohortId === cohortId)
            .sort((a, b) => a.position - b.position)
            .map((selection) => ({
              ...selection,
              groupNumber: this.groupNumberForSubmission(selection.submissionId),
              productName:
                this.db.submissions.find((s) => s.id === selection.submissionId)?.productName ?? null,
            })),
        ),

      /**
       * The only write path to final_selections in the entire codebase, and it
       * requires an actor. No worker, stage, or AI response can reach it.
       */
      setFinalSelection: async (cohortId, selections, actor) => {
        if (selections.length !== 4) {
          throw new Error(`Exactly 4 winners must be selected; received ${selections.length}.`);
        }
        this.db.finalSelections = this.db.finalSelections.filter((s) => s.cohortId !== cohortId);
        const records: FinalSelection[] = selections.map((selection) => ({
          id: newId(),
          cohortId,
          submissionId: selection.submissionId,
          position: selection.position,
          selectedBy: actor,
          selectionReason: selection.reason,
          selectedAt: new Date(),
        }));
        this.db.finalSelections.push(...records);
        return clone(records);
      },

      clearFinalSelection: async (cohortId) => {
        this.db.finalSelections = this.db.finalSelections.filter((s) => s.cohortId !== cohortId);
      },
    };
  }

  // ------------------------------------------------------------------------
  // Resources, audit, settings
  // ------------------------------------------------------------------------

  private buildResourceStore(): ResourceStore {
    return {
      listResources: async (cohortId) =>
        clone(
          this.db.resources
            .filter((r) => cohortId === null || r.cohortId === cohortId || r.cohortId === null)
            .sort((a, b) => a.displayOrder - b.displayOrder),
        ),
      createResource: async (input) => {
        const record: ResourceDocument = { ...clone(input), id: newId(), createdAt: new Date() };
        this.db.resources.push(record);
        return clone(record);
      },
      deleteResource: async (id) => {
        this.db.resources = this.db.resources.filter((r) => r.id !== id);
      },
      /**
       * Demo stand-in for a Supabase signed URL. The shape matches (path plus a
       * bounded expiry) so call sites do not change when the postgres/storage
       * driver replaces this.
       */
      getSignedUrl: async (bucket, path, expiresInSeconds = 300) =>
        `/api/demo-file/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}?expires=${expiresInSeconds}`,
    };
  }

  private buildAuditStore(): AuditStore {
    return {
      record: async (entry) => {
        this.db.auditLogs.push({ ...clone(entry), id: newId(), createdAt: new Date() });
      },
      list: async (filter) =>
        clone(
          this.db.auditLogs
            .filter((log) => {
              if (filter.entityType && log.entityType !== filter.entityType) return false;
              if (filter.entityId && log.entityId !== filter.entityId) return false;
              if (filter.cohortId && log.cohortId !== filter.cohortId) return false;
              return true;
            })
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, filter.limit ?? 200),
        ),
    };
  }

  private buildSettingsStore(): SettingsStore {
    return {
      getAll: async () => clone(this.db.settings),
      get: async <T>(key: string) => {
        const setting = this.db.settings.find((s) => s.key === key);
        return setting ? (clone(setting.value) as T) : null;
      },
      set: async (key, value, actor) => {
        const existing = this.db.settings.find((s) => s.key === key);
        if (existing) {
          existing.value = clone(value);
          existing.updatedBy = actor;
          existing.updatedAt = new Date();
        } else {
          this.db.settings.push({
            key,
            value: clone(value),
            description: '',
            updatedBy: actor,
            updatedAt: new Date(),
          });
        }
      },
    };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private requireSubmission(id: string): Submission {
    const submission = this.db.submissions.find((s) => s.id === id);
    if (!submission) throw new Error(`Submission ${id} not found.`);
    return submission;
  }

  private requireCohort(id: string): Cohort {
    const cohort = this.db.cohorts.find((c) => c.id === id);
    if (!cohort) throw new Error(`Cohort ${id} not found.`);
    return cohort;
  }

  private requireTeam(id: string): Team {
    const team = this.db.teams.find((t) => t.id === id);
    if (!team) throw new Error(`Team ${id} not found.`);
    return team;
  }

  /** Server-side guard: a locked submission or a closed cohort cannot be edited. */
  private assertEditable(submission: Submission): void {
    const cohort = this.requireCohort(submission.cohortId);
    if (!canParticipantEdit(cohort.status, submission.status)) {
      throw new Error(
        submission.status === 'locked'
          ? 'This submission has been finally submitted and is locked. Contact the Outskill team if you need it reopened.'
          : 'This cohort is not currently accepting changes.',
      );
    }
  }

  private createEmptySubmission(cohortId: string, teamId: string): Submission {
    const now = new Date();
    return {
      id: newId(),
      cohortId,
      teamId,
      status: 'draft',
      ideaId: null,
      productName: null,
      primaryUser: null,
      exactProblem: null,
      oneSentencePromise: null,
      briefDescription: null,
      whyAiNecessary: null,
      differentiation: null,
      mustHaveWorkflow: null,
      shouldHaveFeatures: [],
      excludedFeatures: null,
      productUrl: null,
      loginRequired: false,
      coreTestSteps: [],
      safeSampleInputs: null,
      resetInstructions: null,
      knownLimitations: null,
      bugsFixed: [],
      deliberatelyExcluded: null,
      majorTradeoff: null,
      day12ToDay13Changes: null,
      mostImportantLearning: null,
      nextSevenDayPlan: null,
      builderStack: null,
      apisUsed: null,
      externalTemplates: null,
      draftPayload: {},
      draftUpdatedAt: null,
      submittedAt: null,
      receiptId: null,
      lockedAt: null,
      reopenedAt: null,
      reopenedReason: null,
      isLate: false,
      hasLateException: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Copy known draft fields into their typed columns.
   *
   * The raw draft is kept as well, so a partially-filled field that does not
   * yet satisfy its column type is never lost.
   */
  private promoteDraftToColumns(submission: Submission): void {
    const draft = submission.draftPayload as Record<string, Record<string, unknown> | undefined>;
    const product = draft.product ?? {};
    const live = draft.live ?? {};
    const learning = draft.learning ?? {};

    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

    submission.ideaId = str(product.ideaId) ?? submission.ideaId;
    submission.productName = str(product.productName) ?? submission.productName;
    submission.primaryUser = str(product.primaryUser) ?? submission.primaryUser;
    submission.exactProblem = str(product.exactProblem) ?? submission.exactProblem;
    submission.oneSentencePromise = str(product.oneSentencePromise) ?? submission.oneSentencePromise;
    submission.briefDescription = str(product.briefDescription) ?? submission.briefDescription;
    submission.whyAiNecessary = str(product.whyAiNecessary) ?? submission.whyAiNecessary;
    submission.differentiation = str(product.differentiation) ?? submission.differentiation;
    submission.mustHaveWorkflow = str(product.mustHaveWorkflow) ?? submission.mustHaveWorkflow;
    submission.excludedFeatures = str(product.excludedFeatures) ?? submission.excludedFeatures;
    if (Array.isArray(product.shouldHaveFeatures)) {
      submission.shouldHaveFeatures = product.shouldHaveFeatures.filter(
        (f): f is string => typeof f === 'string',
      );
    }

    submission.productUrl = str(live.productUrl) ?? submission.productUrl;
    if (typeof live.loginRequired === 'boolean') submission.loginRequired = live.loginRequired;
    submission.safeSampleInputs = str(live.safeSampleInputs) ?? submission.safeSampleInputs;
    submission.resetInstructions = str(live.resetInstructions) ?? submission.resetInstructions;
    submission.knownLimitations = str(live.knownLimitations) ?? submission.knownLimitations;
    if (Array.isArray(live.coreTestSteps)) {
      submission.coreTestSteps = live.coreTestSteps
        .filter((s): s is { action: string; expectedResult: string } => typeof s === 'object' && s !== null)
        .map((s) => ({ action: String(s.action ?? ''), expectedResult: String(s.expectedResult ?? '') }));
    }

    submission.deliberatelyExcluded = str(learning.deliberatelyExcluded) ?? submission.deliberatelyExcluded;
    submission.majorTradeoff = str(learning.majorTradeoff) ?? submission.majorTradeoff;
    submission.day12ToDay13Changes = str(learning.day12ToDay13Changes) ?? submission.day12ToDay13Changes;
    submission.mostImportantLearning = str(learning.mostImportantLearning) ?? submission.mostImportantLearning;
    submission.nextSevenDayPlan = str(learning.nextSevenDayPlan) ?? submission.nextSevenDayPlan;
    submission.builderStack = str(learning.builderStack) ?? submission.builderStack;
    submission.apisUsed = str(learning.apisUsed) ?? submission.apisUsed;
    submission.externalTemplates = str(learning.externalTemplates) ?? submission.externalTemplates;
    if (Array.isArray(learning.bugsFixed)) {
      submission.bugsFixed = learning.bugsFixed
        .filter((b): b is { description: string; howFixed: string } => typeof b === 'object' && b !== null)
        .map((b) => ({ description: String(b.description ?? ''), howFixed: String(b.howFixed ?? '') }));
    }
  }

  private newJob(submission: Submission): AssessmentJob {
    return {
      id: newId(),
      submissionId: submission.id,
      cohortId: submission.cohortId,
      stage: 'queued',
      priority: 0,
      attemptCount: 0,
      maxAttempts: 3,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      nextAttemptAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private groupNumberForSubmission(submissionId: string): number {
    const submission = this.db.submissions.find((s) => s.id === submissionId);
    if (!submission) return 0;
    return this.db.teams.find((t) => t.id === submission.teamId)?.groupNumber ?? 0;
  }

  private buildListItem(submission: Submission): SubmissionListItem {
    const team = this.db.teams.find((t) => t.id === submission.teamId);
    const job = this.db.jobs.find((j) => j.submissionId === submission.id);
    const summary = job ? this.db.summaries.find((s) => s.jobId === job.id) : undefined;
    const entry = this.db.rankingEntries.find((e) => {
      const snapshot = this.db.rankingSnapshots.find((s) => s.id === e.snapshotId);
      return snapshot?.isCurrent && e.submissionId === submission.id;
    });
    const disqualification = this.db.disqualifications
      .filter((d) => d.submissionId === submission.id)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    return {
      submission,
      team: team as Team,
      ideaTitle: this.db.ideas.find((i) => i.id === submission.ideaId)?.title ?? null,
      stage: job?.stage ?? null,
      totalScore: summary?.totalScore ?? null,
      meanConfidence: summary?.meanConfidence ?? null,
      lowConfidence: summary?.lowConfidence ?? false,
      rank: entry?.rank ?? null,
      inShortlist: entry?.inShortlist ?? false,
      hasOpenManualReview: this.db.manualReviewFlags.some(
        (f) => f.submissionId === submission.id && f.status === 'open',
      ),
      disqualificationStatus: disqualification?.status ?? 'none',
    };
  }

  private buildSubmissionDetail(id: string): AdminSubmissionDetail | null {
    const submission = this.db.submissions.find((s) => s.id === id);
    if (!submission) return null;
    const team = this.db.teams.find((t) => t.id === submission.teamId);
    const cohort = this.db.cohorts.find((c) => c.id === submission.cohortId);
    if (!team || !cohort) return null;

    const job = this.db.jobs.find((j) => j.submissionId === id) ?? null;
    const testPlan = job ? this.db.testPlans.find((p) => p.jobId === job.id) : undefined;
    const entry = this.db.rankingEntries.find((e) => {
      const snapshot = this.db.rankingSnapshots.find((s) => s.id === e.snapshotId);
      return snapshot?.isCurrent && e.submissionId === id;
    });

    return clone({
      submission,
      team,
      members: this.db.teamMembers.filter((m) => m.teamId === team.id).sort((a, b) => a.displayOrder - b.displayOrder),
      cohort,
      idea: this.db.ideas.find((i) => i.id === submission.ideaId) ?? null,
      artifacts: this.db.artifacts.filter((a) => a.submissionId === id),
      declarations: this.db.declarations.find((d) => d.submissionId === id) ?? null,
      credentials: this.db.credentials.find((c) => c.submissionId === id) ?? null,
      events: this.db.events
        .filter((e) => e.submissionId === id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      job,
      preflight: job
        ? this.db.preflight
            .filter((p) => p.jobId === job.id)
            .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())
        : [],
      artifactAnalysis: job ? (this.db.artifactAnalyses.find((a) => a.jobId === job.id) ?? null) : null,
      testPlan: testPlan
        ? {
            ...testPlan,
            steps: this.db.testPlanSteps
              .filter((s) => s.testPlanId === testPlan.id)
              .sort((a, b) => a.stepIndex - b.stepIndex),
          }
        : null,
      browserRuns: job
        ? this.db.browserRuns
            .filter((r) => r.jobId === job.id)
            .map((run) => ({
              ...run,
              steps: this.db.browserSteps
                .filter((s) => s.runId === run.id)
                .sort((a, b) => a.stepIndex - b.stepIndex),
            }))
        : [],
      evidence: job ? this.db.evidence.filter((e) => e.jobId === job.id) : [],
      scores: job
        ? this.db.scores
            .filter((s) => s.jobId === job.id)
            .sort((a, b) => rubricOrder(a.categoryKey) - rubricOrder(b.categoryKey))
        : [],
      summary: job ? (this.db.summaries.find((s) => s.jobId === job.id) ?? null) : null,
      consistencyReviews: job ? this.db.consistencyReviews.filter((c) => c.jobId === job.id) : [],
      manualReviewFlags: this.db.manualReviewFlags.filter((f) => f.submissionId === id),
      disqualifications: this.db.disqualifications.filter((d) => d.submissionId === id),
      feedbackReport: this.db.feedbackReports.find((r) => r.submissionId === id) ?? null,
      auditLogs: this.db.auditLogs
        .filter((l) => l.entityId === id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      rank: entry?.rank ?? null,
      inShortlist: entry?.inShortlist ?? false,
    });
  }

  private recalculateSummary(jobId: string): void {
    const summary = this.db.summaries.find((s) => s.jobId === jobId);
    if (!summary) return;
    const scores = this.db.scores.filter((s) => s.jobId === jobId);
    summary.totalScore = totalScore(
      scores.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore })),
    );
    const confidences = scores.map((s) => s.confidence);
    summary.meanConfidence =
      Math.round((confidences.reduce((a, b) => a + b, 0) / (confidences.length || 1)) * 100) / 100;
    summary.minConfidence = confidences.length ? Math.min(...confidences) : 0;
  }

  private collectRankable(cohortId: string): RankableSubmission[] {
    const result: RankableSubmission[] = [];
    for (const job of this.db.jobs.filter((j) => j.cohortId === cohortId)) {
      if (job.stage !== 'completed') continue;
      if (
        this.db.disqualifications.some(
          (d) => d.submissionId === job.submissionId && d.status === 'confirmed',
        )
      ) {
        continue;
      }
      const scores = this.db.scores.filter((s) => s.jobId === job.id);
      if (scores.length !== RUBRIC_CATEGORIES.length) continue;
      const summary = this.db.summaries.find((s) => s.jobId === job.id);
      const openFlags = this.db.manualReviewFlags.filter(
        (f) => f.submissionId === job.submissionId && f.status === 'open',
      ).length;
      result.push({
        submissionId: job.submissionId,
        scores: scores.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore })),
        unresolvedRiskCount: openFlags + (summary?.risks.length ?? 0),
        meanConfidence: summary?.meanConfidence ?? 0,
      });
    }
    return result;
  }

  private computeQueueStats(cohortId: string): QueueStats {
    const jobs = this.db.jobs.filter((j) => j.cohortId === cohortId);
    const byStage = Object.fromEntries(
      ALL_STAGES.map((stage) => [stage, jobs.filter((j) => j.stage === stage).length]),
    ) as Record<AssessmentStage, number>;

    const durations = jobs
      .filter((j) => j.startedAt && j.completedAt)
      .map((j) => (j.completedAt as Date).getTime() - (j.startedAt as Date).getTime());
    const averageDurationMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const remaining = jobs.filter(
      (j) => !['completed', 'failed', 'disqualified', 'manual_review'].includes(j.stage),
    ).length;
    const cohort = this.db.cohorts.find((c) => c.id === cohortId);
    const concurrency = cohort?.assessmentConfig.workerConcurrency ?? 4;
    const projectedCompletionAt =
      averageDurationMs && remaining > 0
        ? new Date(Date.now() + Math.ceil(remaining / concurrency) * averageDurationMs)
        : null;

    const browserMs = this.db.browserRuns
      .filter((r) => jobs.some((j) => j.id === r.jobId))
      .reduce((sum, r) => sum + (r.durationMs ?? 0), 0);

    // Each assessed submission makes one artifact-analysis, one test-plan, one
    // scoring call, plus one per consistency review.
    const assessedJobIds = new Set(this.db.artifactAnalyses.map((a) => a.jobId));
    const aiCallCount =
      assessedJobIds.size * 3 +
      this.db.consistencyReviews.filter((c) => jobs.some((j) => j.id === c.jobId)).length;

    return {
      total: jobs.length,
      byStage,
      completed: byStage.completed,
      running: jobs.filter((j) => j.claimedBy !== null).length,
      failed: byStage.failed,
      manualReview: byStage.manual_review,
      averageDurationMs,
      projectedCompletionAt,
      browserMinutesUsed: Math.round(browserMs / 600) / 100,
      aiCallCount,
      // Rough per-call estimate; real token accounting arrives with the adapter.
      estimatedTokensUsed: aiCallCount * 4200,
    };
  }
}

const CLAIMABLE_STAGES: AssessmentStage[] = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
];

const ALL_STAGES: AssessmentStage[] = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
  'completed',
  'manual_review',
  'failed',
  'disqualified',
];

function rubricOrder(key: string): number {
  return RUBRIC_CATEGORIES.find((c) => c.key === key)?.displayOrder ?? 99;
}

function pick(entry: RankableSubmission, key: RubricCategoryKey): number {
  return entry.scores.find((s) => s.categoryKey === key)?.weightedScore ?? 0;
}

/** Unused import guard — these types document the driver's surface. */
export type { SubmissionStatus, SubmissionDeclarations, SubmissionEvent, TeamMember, PreflightCheck, AssessmentEvidence, CategoryScore, AuditLog, SystemSetting, AdminSession, AdminAccount, TestPlanStep, BrowserTestStep };
