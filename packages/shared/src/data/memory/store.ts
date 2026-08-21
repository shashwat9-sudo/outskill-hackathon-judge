/**
 * Memory driver — the demo-mode implementation of `DataStore`.
 *
 * Satisfies the same interfaces as the postgres driver, including lease-based
 * job claiming, so behaviour that depends on queue semantics can be tested
 * without a database.
 */

import { RUBRIC_CATEGORIES, RUBRIC_VERSION, totalScore, weightedScore } from '../../rubric/index';
import {
  deserialiseEnvelope,
  decryptSecret,
  encryptSecret,
  generateInviteToken,
  hashInviteToken,
  serialiseEnvelope,
} from '../../security/crypto';
import {
  GENERIC_VERIFICATION_ERROR,
  clearVerificationAttempts,
  evaluateVerificationAttempt,
  generateAccessCode,
  registerFailedVerification,
  verifyAccessCode,
} from '../../security/access-code';
import {
  computeSessionExpiry,
  evaluateParticipantSession,
  generateParticipantSessionToken,
  hashParticipantSessionToken,
} from '../../security/participant-session';
import {
  computeSubmissionWindow,
  evaluateParticipantPermissions,
  needsDeadlineReconciliation,
  validateReopen,
} from '../../domain/submission-window';
import { checkVersion } from '../../domain/concurrency';
import {
  EVIDENCE_BUCKETS,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_UPLOAD_TTL_SECONDS,
  evidencePathBelongsTo,
  evidenceTarget,
} from '../../domain/evidence-path';
import { MAX_DECK_BYTES, looksLikePdf, validateDeckUpload } from '../../schemas/submission';
import { assessCohortDeletion, confirmationMatches } from '../../domain/cohort-deletion';
import {
  checkCohortExclusivity,
  isLearnerFacing,
  resolveLearnerFacingCohort,
} from '../../domain/cohort-exclusivity';
import { compareForRanking, type RankableSubmission } from '../../domain/ranking';
import { type AssessmentStage, type CohortStatus, type SubmissionStatus } from '../../domain/status';
import { isSubmissionLate } from '../../domain/deadline';
import { demoAccessCode } from '../../fixtures/demo';
import { generateReceiptId, newId } from '../../domain/ids';
import { assertDisqualificationAllowed } from '../../domain/disqualification';
import type { RubricCategoryKey } from '../../rubric/index';
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
} from '../types';
import type {
  AccessCodeStatus,
  AdminAuthStore,
  AssessmentStore,
  CreatedSession,
  CreateSessionInput,
  FinaliseResult,
  GeneratedAccessCodeRow,
  ParticipantReceipt,
  SaveDraftResult,
  VerifyTeamResult,
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
  LearnerAllocationResult,
  TeamImportResult,
  TeamStore,
} from '../store';
import { createEmptyDatabase, seedDemoDatabase, type MemoryDatabase } from './database';

const DEMO_KEY = Buffer.alloc(32, 7);
const clone = <T>(value: T): T => structuredClone(value);

/**
 * The fields that make an idea's definition "expanded" rather than sourced.
 *
 * Title and description come from the approved idea catalogue. Everything here
 * is Outskill's interpretation of what the idea means, and it is what test-plan
 * generation reads — so it is what approval is about.
 */
const EXPANDED_DEFINITION_FIELDS = [
  'targetUser',
  'expectedUseCase',
  'minimumCoreFlow',
  'expectedEntities',
  'aiOpportunity',
  'allowedScope',
  'unsafeInterpretations',
] as const satisfies readonly (keyof CohortIdea)[];

/** Would this patch change what judging measures against? */
function changesExpandedDefinition(current: CohortIdea, patch: Partial<CohortIdea>): boolean {
  return EXPANDED_DEFINITION_FIELDS.some(
    (field) =>
      field in patch && JSON.stringify(patch[field]) !== JSON.stringify(current[field]),
  );
}

export class MemoryDataStore implements DataStore {
  readonly driver = 'memory' as const;
  private db: MemoryDatabase;

  /**
   * Access codes are Argon2id-hashed, which is asynchronous, but seeding the
   * rest of the fixtures is not. Methods that touch codes or sessions await
   * this once; everything else stays synchronous.
   */
  private ready: Promise<void>;
  /** Keys the participant session hash. Demo-only value; production injects one. */
  private readonly sessionSecret: string | undefined;

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

  constructor(options: { seed?: boolean; sessionSecret?: string } = {}) {
    this.db = createEmptyDatabase();
    this.sessionSecret = options.sessionSecret;
    if (options.seed !== false) seedDemoDatabase(this.db);
    this.ready = options.seed === false ? Promise.resolve() : this.seedAccessCodes();

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
    this.ready = this.seedAccessCodes();
    await this.ready;
  }

  /**
   * Seed one access code per demo team.
   *
   * Deterministic per group number so the demo home can print working codes and
   * an operator can exercise the real /submit verification path end to end.
   */
  private async seedAccessCodes(): Promise<void> {
    const { hashPassword } = await import('../../security/password');
    for (const team of this.db.teams) {
      if (this.db.accessCodes.some((c) => c.teamId === team.id)) continue;
      const plaintext = demoAccessCode(team.groupNumber);
      this.db.accessCodes.push({
        id: newId(),
        teamId: team.id,
        cohortId: team.cohortId,
        groupNumber: team.groupNumber,
        codeHash: await hashPassword(plaintext),
        version: 1,
        createdAt: team.importedAt,
        revokedAt: null,
        lastVerifiedAt: null,
        verifyCount: 0,
      });
    }
  }

  /** Demo-only: the plaintext code for a team, so the demo can display it. */
  getDemoAccessCode(groupNumber: number): string {
    return demoAccessCode(groupNumber);
  }

  /** Await fixture readiness. Tests call this before asserting on codes. */
  async whenReady(): Promise<void> {
    await this.ready;
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

  /**
   * An invite that is still usable.
   *
   * Unknown, revoked and expired all return undefined, so no caller can tell
   * them apart and accidentally turn one into a different error message.
   */
  private findLiveInvite(token: string): TeamInvite | undefined {
    const hash = hashInviteToken(token);
    const invite = this.db.teamInvites.find((i) => i.tokenHash === hash);
    if (!invite || invite.revokedAt) return undefined;
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return undefined;
    return invite;
  }

  // ------------------------------------------------------------------------
  // Participant
  // ------------------------------------------------------------------------

  /** Deck bytes uploaded during a demo run. Never persisted anywhere. */
  private readonly demoDeckBytes = new Map<string, Uint8Array>();
  /** Evidence objects, keyed `<bucket>/<path>` exactly as production keys them. */
  private readonly demoEvidenceBytes = new Map<string, Uint8Array>();

  private buildParticipantStore(): ParticipantStore {
    const db = () => this.db;

    /** Resolve a session token to its team, or null. Used by every write. */
    const resolve = async (token: string) => {
      await this.ready;
      const hash = hashParticipantSessionToken(token, this.sessionSecret);
      const session = db().participantSessions.find((s) => s.sessionTokenHash === hash);
      if (!session) return null;

      const code = db().accessCodes.find((c) => c.teamId === session.teamId && !c.revokedAt);
      const validity = evaluateParticipantSession(session, code?.version ?? -1);
      if (!validity.valid) return null;

      const team = db().teams.find((t) => t.id === session.teamId);
      const cohort = db().cohorts.find((c) => c.id === session.cohortId);
      if (!team || !cohort) return null;

      let submission = db().submissions.find((x) => x.teamId === team.id && x.cohortId === cohort.id);
      if (!submission) {
        submission = this.createEmptySubmission(cohort.id, team.id);
        db().submissions.push(submission);
      }

      session.lastActiveAt = new Date();
      return { session, team, cohort, submission };
    };

    /** Writes are refused unless the server-side window and status both allow it. */
    const assertWritable = (
      cohort: Cohort,
      submission: Submission,
    ): { ok: true } | { ok: false; error: string } => {
      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      return permissions.canEdit ? { ok: true } : { ok: false, error: permissions.reason };
    };

    return {
      verifyTeamAccess: async ({ groupNumber, code, ipHash }): Promise<VerifyTeamResult> => {
        await this.ready;
        const now = new Date();

        // Rate limiting is keyed on hashed IP AND group, so one hostile client
        // cannot lock a team out and one team cannot lock out an office.
        const key = db().verificationAttempts.find(
          (a) => a.ipHash === ipHash && a.groupNumber === groupNumber,
        );
        const decision = evaluateVerificationAttempt(
          key ? { attempts: key.attempts, windowStartedAt: key.windowStartedAt, lockedUntil: key.lockedUntil } : null,
          now,
        );

        if (!decision.allowed) {
          return {
            ok: false,
            reason: 'rate_limited',
            message: `Too many attempts. Try again in ${Math.ceil(decision.retryAfterSeconds / 60)} minute(s), or contact the Outskill programme team.`,
            retryAfterSeconds: decision.retryAfterSeconds,
          };
        }

        const recordFailure = () => {
          const next = registerFailedVerification(
            key ? { attempts: key.attempts, windowStartedAt: key.windowStartedAt, lockedUntil: key.lockedUntil } : null,
            now,
          );
          if (key) {
            Object.assign(key, next, { updatedAt: now });
          } else {
            db().verificationAttempts.push({
              id: newId(),
              cohortId: '',
              groupNumber,
              ipHash,
              ...next,
              updatedAt: now,
            });
          }
        };

        // Every failure below returns the SAME message, so the form cannot be
        // used to discover which group numbers exist.
        const team = db().teams.find((t) => t.groupNumber === groupNumber && t.status === 'active');
        if (!team) {
          recordFailure();
          return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
        }

        const accessCode = db().accessCodes.find((c) => c.teamId === team.id && !c.revokedAt);
        if (!accessCode) {
          recordFailure();
          return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
        }

        if (!(await verifyAccessCode(code, accessCode.codeHash))) {
          recordFailure();
          return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
        }

        // Success clears the counter, so a team that fumbled then succeeded is
        // not still one attempt from a lockout.
        if (key) Object.assign(key, clearVerificationAttempts(now), { updatedAt: now });
        accessCode.lastVerifiedAt = now;
        accessCode.verifyCount += 1;

        return { ok: true, teamId: team.id, cohortId: team.cohortId, groupNumber };
      },

      createSession: async (input: CreateSessionInput): Promise<CreatedSession> => {
        await this.ready;
        const team = this.requireTeam(input.teamId);
        const cohort = this.requireCohort(team.cohortId);
        const accessCode = this.db.accessCodes.find((c) => c.teamId === team.id && !c.revokedAt);

        const window = computeSubmissionWindow(cohort);
        const expiresAt = computeSessionExpiry(window.effectiveDeadline);
        const { token, tokenHash } = generateParticipantSessionToken();

        this.db.participantSessions.push({
          id: newId(),
          teamId: team.id,
          cohortId: cohort.id,
          sessionTokenHash: hashParticipantSessionToken(token, this.sessionSecret) || tokenHash,
          editorName: input.editorName,
          editorRole: input.editorRole,
          accessCodeVersion: accessCode?.version ?? 1,
          createdAt: new Date(),
          lastActiveAt: new Date(),
          expiresAt,
          revokedAt: null,
          ipHash: input.ipHash,
        });

        return { token, expiresAt };
      },

      resolveSession: async (token: string): Promise<ParticipantView | null> => {
        const resolved = await resolve(token);
        if (!resolved) return null;
        const { session, team, cohort, submission } = resolved;

        const permissions = evaluateParticipantPermissions(cohort, submission.status);

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
          members: this.db.teamMembers
            .filter((m) => m.teamId === team.id)
            .sort((a, b) => a.displayOrder - b.displayOrder),
          submission,
          artifacts: this.db.artifacts.filter((a) => a.submissionId === submission.id),
          declarations: this.db.declarations.find((d) => d.submissionId === submission.id) ?? null,
          ideas: this.db.ideas
            .filter((i) => i.cohortId === cohort.id && i.isActive)
            .sort((a, b) => a.displayOrder - b.displayOrder),
          hasStoredCredentials: this.db.credentials.some(
            (c) => c.submissionId === submission.id && !c.deletedAt,
          ),
          canEdit: permissions.canEdit,
          canSubmit: permissions.canSubmit,
          windowMessage: permissions.reason,
          effectiveDeadline: permissions.window.effectiveDeadline,
          editorName: session.editorName,
          recentActivity: this.db.teamActivity
            .filter((a) => a.submissionId === submission.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 8),
        });
      },

      endSession: async (token: string) => {
        await this.ready;
        const hash = hashParticipantSessionToken(token, this.sessionSecret);
        const session = this.db.participantSessions.find((s) => s.sessionTokenHash === hash);
        if (session) session.revokedAt = new Date();
      },

      resolveInviteTeam: async (token) => {
        await this.ready;
        const invite = this.findLiveInvite(token);
        if (!invite) return null;
        const team = this.db.teams.find((t) => t.id === invite.teamId);
        return team ? { teamId: team.id, groupNumber: team.groupNumber } : null;
      },

      redeemInviteToken: async (token, editor): Promise<CreatedSession | null> => {
        await this.ready;
        const invite = this.findLiveInvite(token);
        if (!invite) return null;

        invite.lastAccessedAt = new Date();
        invite.accessCount += 1;

        return this.participant.createSession({
          teamId: invite.teamId,
          editorName: editor.name,
          editorRole: editor.role,
          ipHash: null,
        });
      },

      saveDraft: async (token, draft, expectedVersion): Promise<SaveDraftResult> => {
        const resolved = await resolve(token);
        if (!resolved) return { ok: false, error: 'Your session has ended. Sign in again to continue.' };
        const { session, cohort, submission } = resolved;

        const writable = assertWritable(cohort, submission);
        if (!writable.ok) return { ok: false, error: writable.error };

        // Optimistic concurrency: a stale write is refused rather than allowed
        // to silently overwrite a teammate.
        const versionCheck = checkVersion({ expectedVersion, currentVersion: submission.version });
        if (!versionCheck.ok) {
          return {
            ok: false,
            conflict: { currentVersion: versionCheck.currentVersion, message: versionCheck.message },
            submission: clone(submission),
          };
        }

        // Merged per step, matching production. Replacing would let a partial
        // save destroy every other step's payload.
        submission.draftPayload = {
          ...((submission.draftPayload ?? {}) as Record<string, unknown>),
          ...clone(draft),
        };
        submission.draftUpdatedAt = new Date();
        submission.updatedAt = new Date();
        submission.version = versionCheck.nextVersion;
        submission.lastEditedBy = session.editorName;
        this.promoteDraftToColumns(submission);

        return { ok: true, submission: clone(submission) };
      },

      finaliseSubmission: async (token, context): Promise<FinaliseResult> => {
        const resolved = await resolve(token);
        if (!resolved) return { ok: false, error: 'Your session has ended. Sign in again to continue.' };
        const { session, team, cohort, submission } = resolved;

        const permissions = evaluateParticipantPermissions(cohort, submission.status);
        if (!permissions.canSubmit) return { ok: false, error: permissions.reason };

        // Already final — never mint a second receipt for the same submission.
        if (submission.receiptId && submission.status === 'locked') {
          return { ok: false, error: 'This submission has already been finalised.' };
        }

        // The selected idea must still be approved for the cohort.
        const idea = this.db.ideas.find((i) => i.id === submission.ideaId);
        if (!idea || !idea.isActive) {
          return {
            ok: false,
            error: 'The selected product idea is no longer available for this cohort. Choose an approved idea.',
          };
        }

        const deck = this.db.artifacts.find(
          (a) => a.submissionId === submission.id && a.kind === 'deck_pdf' && a.uploadCompletedAt,
        );
        if (!deck) return { ok: false, error: 'Upload your pitch deck as a PDF before submitting.' };

        const video = this.db.artifacts.find(
          (a) => a.submissionId === submission.id && a.kind === 'demo_video' && a.externalUrl,
        );
        if (!video) return { ok: false, error: 'Add your demo video link before submitting.' };
        if (!submission.productUrl) return { ok: false, error: 'Add your live product URL before submitting.' };

        const now = new Date();
        submission.status = 'locked';
        submission.submittedAt = now;
        submission.submittedByName = session.editorName;
        submission.lockedAt = now;
        submission.updatedAt = now;
        submission.version += 1;
        submission.isLate = isSubmissionLate(now, cohort.day13DeadlineAt);
        submission.receiptId ??= generateReceiptId(cohort.code, team.groupNumber);

        const declarations = this.db.declarations.find((d) => d.submissionId === submission.id);
        if (declarations) {
          declarations.acceptedAt = now;
          declarations.acceptedIpHash = context.ipHash;
        }

        this.db.events.push({
          id: newId(),
          submissionId: submission.id,
          eventType: 'final_submitted',
          actorType: 'participant',
          detail: { receiptId: submission.receiptId, by: session.editorName },
          createdAt: now,
        });
        this.db.teamActivity.push({
          id: newId(),
          submissionId: submission.id,
          teamId: team.id,
          kind: 'final_submitted',
          editorName: session.editorName,
          section: null,
          createdAt: now,
        });

        return { ok: true, receiptId: submission.receiptId };
      },

      /**
       * Demo mode holds the bytes in memory.
       *
       * Same contract as production — bytes first, record second — so the demo
       * cannot show a success that the real path would not have produced.
       */
      uploadDeck: async (token, input) => {
        await this.ready;
        const resolved = await resolve(token);
        if (!resolved) return null;
        const { cohort, submission } = resolved;
        if (!assertWritable(cohort, submission).ok) return null;

        const path = `${cohort.id}/${submission.id}/pitch-deck.pdf`;
        this.demoDeckBytes.set(path, input.bytes);

        return this.participant.attachArtifact(token, {
          kind: 'deck_pdf',
          storageBucket: 'submission-decks',
          storagePath: path,
          originalFilename: input.originalFilename,
          mimeType: input.mimeType,
          byteSize: input.bytes.byteLength,
          checksumSha256: null,
          externalUrl: null,
          uploadCompletedAt: new Date(),
          isAccessible: true,
          lastCheckedAt: new Date(),
        });
      },

      /**
       * Demo mode has no bucket to sign against, so it hands back a URL this
       * process serves itself.
       *
       * The two-step shape is kept exactly as production has it — a ticket, an
       * upload, then a confirmation that checks the bytes — because a demo that
       * skips the confirmation would show a success the real path might refuse.
       */
      createDeckUploadTicket: async (token, input) => {
        await this.ready;
        const resolved = await resolve(token);
        if (!resolved) return { ok: false, error: 'Your session has expired. Sign in again to continue.' };
        const { cohort, submission } = resolved;

        const writable = assertWritable(cohort, submission);
        if (!writable.ok) return { ok: false, error: writable.error };

        const declared = validateDeckUpload({
          name: input.originalFilename,
          type: input.mimeType,
          size: input.byteSize,
        });
        if (!declared.ok) return { ok: false, error: declared.message };

        const storagePath = `${cohort.id}/${submission.id}/pending-${this.db.artifacts.length}-${Date.now()}.pdf`;
        return {
          ok: true,
          uploadUrl: `/api/demo-upload/${encodeURIComponent('submission-decks')}/${encodeURIComponent(storagePath)}`,
          uploadToken: 'demo',
          storagePath,
          maxBytes: MAX_DECK_BYTES,
        };
      },

      confirmDeckUpload: async (token, input) => {
        await this.ready;
        const resolved = await resolve(token);
        if (!resolved) return { ok: false, error: 'Your session has expired. Sign in again to continue.' };
        const { cohort, submission } = resolved;

        const writable = assertWritable(cohort, submission);
        if (!writable.ok) return { ok: false, error: writable.error };

        // The browser's only input, and therefore the only thing to check.
        const prefix = `${cohort.id}/${submission.id}/`;
        if (!input.storagePath.startsWith(prefix) || input.storagePath.includes('..')) {
          return { ok: false, error: 'That upload does not belong to this submission.' };
        }

        const bytes = this.demoDeckBytes.get(input.storagePath);
        if (!bytes) {
          return { ok: false, error: 'The upload did not finish. Choose the file and try again.' };
        }
        if (bytes.byteLength > MAX_DECK_BYTES) {
          this.demoDeckBytes.delete(input.storagePath);
          return { ok: false, error: 'The pitch deck must be 25 MB or smaller.' };
        }
        if (!looksLikePdf(bytes.slice(0, 8))) {
          this.demoDeckBytes.delete(input.storagePath);
          return {
            ok: false,
            error: 'That file is not a PDF. Export your deck as a PDF and upload it again.',
          };
        }

        const previous = this.db.artifacts
          .filter((a) => a.submissionId === submission.id && a.kind === 'deck_pdf')
          .map((a) => a.storagePath)
          .filter((path): path is string => Boolean(path) && path !== input.storagePath);

        const artifact = await this.participant.attachArtifact(token, {
          kind: 'deck_pdf',
          storageBucket: 'submission-decks',
          storagePath: input.storagePath,
          originalFilename: input.originalFilename,
          mimeType: 'application/pdf',
          byteSize: bytes.byteLength,
          checksumSha256: null,
          externalUrl: null,
          uploadCompletedAt: new Date(),
          isAccessible: true,
          lastCheckedAt: new Date(),
        });

        if (!artifact) {
          this.demoDeckBytes.delete(input.storagePath);
          return { ok: false, error: 'Could not record the upload. Your previous deck is unchanged.' };
        }

        for (const path of previous) this.demoDeckBytes.delete(path);
        return { ok: true, artifact };
      },

      attachArtifact: async (token, artifact) => {
        const resolved = await resolve(token);
        if (!resolved) return null;
        const { cohort, submission, session } = resolved;

        const writable = assertWritable(cohort, submission);
        if (!writable.ok) return null;

        // One deck and one demo video per submission — replace, never append.
        if (artifact.kind === 'deck_pdf' || artifact.kind === 'demo_video') {
          this.db.artifacts = this.db.artifacts.filter(
            (a) => !(a.submissionId === submission.id && a.kind === artifact.kind),
          );
        }
        const record: SubmissionArtifact = {
          ...clone(artifact),
          id: newId(),
          submissionId: submission.id,
          createdAt: new Date(),
        };
        this.db.artifacts.push(record);

        this.db.teamActivity.push({
          id: newId(),
          submissionId: submission.id,
          teamId: submission.teamId,
          kind: artifact.kind === 'deck_pdf' ? 'deck_replaced' : 'demo_link_saved',
          editorName: session.editorName,
          section: 'Demo and deck',
          createdAt: new Date(),
        });

        return clone(record);
      },

      removeArtifact: async (token, artifactId) => {
        const resolved = await resolve(token);
        if (!resolved) return;
        const { cohort, submission } = resolved;
        if (!assertWritable(cohort, submission).ok) return;
        this.db.artifacts = this.db.artifacts.filter(
          (a) => !(a.id === artifactId && a.submissionId === submission.id),
        );
      },

      storeCredentials: async (token, values) => {
        const resolved = await resolve(token);
        if (!resolved) return;
        const { cohort, submission } = resolved;
        if (!assertWritable(cohort, submission).ok) return;

        const existing = this.db.credentials.find((c) => c.submissionId === submission.id);
        const enc = (value: string | undefined) =>
          value && value.length > 0 ? serialiseEnvelope(encryptSecret(value, DEMO_KEY)) : null;

        const record: SubmissionCredentials = existing ?? {
          id: newId(),
          submissionId: submission.id,
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

      recordActivity: async (token, kind, section) => {
        const resolved = await resolve(token);
        if (!resolved) return;
        const { session, submission } = resolved;

        // Collapse repeats: the same editor doing the same thing to the same
        // section within a minute is one entry, not a flood.
        const recent = this.db.teamActivity.find(
          (a) =>
            a.submissionId === submission.id &&
            a.kind === kind &&
            a.editorName === session.editorName &&
            (a.section ?? null) === (section ?? null) &&
            Date.now() - a.createdAt.getTime() < 60_000,
        );
        if (recent) {
          recent.createdAt = new Date();
          return;
        }

        this.db.teamActivity.push({
          id: newId(),
          submissionId: submission.id,
          teamId: submission.teamId,
          kind,
          editorName: session.editorName,
          section: section ?? null,
          createdAt: new Date(),
        });
      },

      getReceipt: async (token): Promise<ParticipantReceipt | null> => {
        const resolved = await resolve(token);
        if (!resolved) return null;
        const { team, cohort, submission } = resolved;
        if (!submission.receiptId || !submission.submittedAt) return null;

        const idea = this.db.ideas.find((i) => i.id === submission.ideaId);
        return {
          cohortName: cohort.name,
          cohortTimezone: cohort.timezone,
          groupNumber: team.groupNumber,
          productName: submission.productName ?? 'Untitled',
          ideaTitle: idea?.title ?? '—',
          submittedByName: submission.submittedByName ?? 'the team',
          submittedAt: submission.submittedAt,
          receiptId: submission.receiptId,
        };
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
      listLearnerFacingCohorts: async () =>
        clone(this.db.cohorts.filter((c) => isLearnerFacing(c.status))),

      findActiveCohort: async () => {
        // Exactly one learner-facing cohort, or none — never a guess between
        // two. Same rule as the production driver, so demo mode cannot teach an
        // operator something that is not true in production.
        const facing = resolveLearnerFacingCohort(this.db.cohorts);
        if (facing.cohort) return clone(facing.cohort);
        if (facing.ambiguous) return null;

        // Ranked, not filtered: between cohorts the entry page still needs
        // something to name and a window state to explain.
        const rank = (cohort: Cohort) =>
          ({ open: 0, paused: 1, closed: 2, judging: 3, draft: 4, finalised: 5, archived: 6 })[
            cohort.status
          ] ?? 9;
        const candidates = [...this.db.cohorts].sort(
          (a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return candidates[0] ? clone(candidates[0]) : null;
      },
      createCohort: async (input) => {
        if (this.db.cohorts.some((c) => c.code.toLowerCase() === input.code.toLowerCase())) {
          throw new Error(`A cohort with code "${input.code}" already exists.`);
        }
        const cohort: Cohort = {
          ...input,
          id: newId(),
          finalisedAt: null,
          // Cohorts are real unless an operator says otherwise, in memory as in
          // Postgres. The input type cannot carry this field.
          isSynthetic: false,
          externalCohortId: null,
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
      getCohortDependencies: async (id) => {
        const teamIds = this.db.teams.filter((t) => t.cohortId === id).map((t) => t.id);
        const submissionIds = this.db.submissions
          .filter((s) => s.cohortId === id)
          .map((s) => s.id);
        const jobIds = this.db.jobs.filter((j) => j.cohortId === id).map((j) => j.id);

        return {
          teams: teamIds.length,
          teamMembers: this.db.teamMembers.filter((m) => teamIds.includes(m.teamId)).length,
          submissions: submissionIds.length,
          finalSubmissions: this.db.submissions.filter(
            (s) => s.cohortId === id && s.status !== 'draft',
          ).length,
          artifacts: this.db.artifacts.filter((a) => submissionIds.includes(a.submissionId)).length,
          accessCodes: this.db.accessCodes.filter((c) => c.cohortId === id).length,
          participantSessions: this.db.participantSessions.filter((s) => s.cohortId === id).length,
          assessmentJobs: jobIds.length,
          categoryScores: this.db.scores.filter((s) => jobIds.includes(s.jobId)).length,
          rankingSnapshots: this.db.rankingSnapshots.filter((s) => s.cohortId === id).length,
          finalSelections: this.db.finalSelections.filter((s) => s.cohortId === id).length,
          auditEntries: this.db.auditLogs.filter((a) => a.cohortId === id).length,
        };
      },

      archiveCohort: async (id, actor) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);
        const previousStatus = cohort.status;

        // Archiving ends learner access rather than letting sessions run out.
        this.db.participantSessions
          .filter((s) => s.cohortId === id && !s.revokedAt)
          .forEach((s) => {
            s.revokedAt = new Date();
          });
        cohort.status = 'archived';
        cohort.updatedAt = new Date();

        this.db.auditLogs.push({
          id: newId(),
          actorType: 'shared-admin',
          actorRef: actor,
          action: 'cohort.archived',
          entityType: 'cohort',
          entityId: id,
          cohortId: id,
          before: { status: previousStatus },
          after: { status: 'archived' },
          ipHash: null,
          userAgentHash: null,
          createdAt: new Date(),
        });
        return clone(cohort);
      },

      deleteCohortPermanently: async (id, input) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);

        const dependencies = await this.cohorts.getCohortDependencies(id);
        const assessment = assessCohortDeletion(cohort.name, dependencies);
        if (assessment.verdict !== 'deletable') {
          throw new Error(
            `“${cohort.name}” holds work and cannot be deleted: ${assessment.blockers.join(' ')} ` +
              'Archive it instead.',
          );
        }
        if (!confirmationMatches(input.confirmationPhrase, cohort.name)) {
          throw new Error(`Type the cohort name exactly to confirm: ${cohort.name}`);
        }

        // Audit first: the record must outlive what it describes.
        this.db.auditLogs.push({
          id: newId(),
          actorType: 'shared-admin',
          actorRef: input.actor,
          action: 'cohort.deleted_permanently',
          entityType: 'cohort',
          entityId: id,
          cohortId: null,
          before: null,
          after: { name: cohort.name, code: cohort.code, removed: assessment.willRemove },
          ipHash: null,
          userAgentHash: null,
          createdAt: new Date(),
        });

        const teamIds = this.db.teams.filter((t) => t.cohortId === id).map((t) => t.id);
        this.db.teams = this.db.teams.filter((t) => t.cohortId !== id);
        this.db.teamMembers = this.db.teamMembers.filter((m) => !teamIds.includes(m.teamId));
        this.db.ideas = this.db.ideas.filter((i) => i.cohortId !== id);
        this.db.accessCodes = this.db.accessCodes.filter((c) => c.cohortId !== id);
        this.db.participantSessions = this.db.participantSessions.filter((s) => s.cohortId !== id);
        this.db.cohorts = this.db.cohorts.filter((c) => c.id !== id);

        return { deleted: true as const, removed: assessment.willRemove };
      },

      setCohortStatus: async (id, status: CohortStatus) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);

        const exclusivity = checkCohortExclusivity(cohort, status, this.db.cohorts);
        if (!exclusivity.allowed) throw new Error(exclusivity.reason);
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

        // Changing what judging is measured against un-approves the definition.
        // Enforced here rather than in each caller: an approval that survives an
        // edit is worse than no approval at all, because it looks reviewed.
        const reverts = changesExpandedDefinition(idea, patch);

        Object.assign(idea, patch, { id: idea.id, updatedAt: new Date() });
        if (reverts) {
          idea.definitionStatus = 'draft';
          idea.definitionApprovedAt = null;
          idea.definitionApprovedBy = null;
        }
        return clone(idea);
      },
      deleteIdea: async (id) => {
        // Soft-delete: a past submission must keep resolving its idea.
        const idea = this.db.ideas.find((i) => i.id === id);
        if (idea) idea.isActive = false;
      },
      closeSubmissions: async (id, closureType) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);
        cohort.status = 'closed';
        cohort.closedAt = new Date();
        cohort.closureType = closureType;
        // A closure supersedes any temporary extension.
        cohort.acceptingUntil = null;
        cohort.updatedAt = new Date();
        return clone(cohort);
      },

      reopenSubmissions: async (id, input) => {
        const cohort = this.db.cohorts.find((c) => c.id === id);
        if (!cohort) throw new Error(`Cohort ${id} not found.`);

        // Refuse a reopen that would leave the cohort open but rejecting writes.
        const validation = validateReopen(cohort, input);
        if (!validation.valid) throw new Error(validation.problems.join(' '));

        cohort.status = 'open';
        cohort.closedAt = null;
        cohort.closureType = null;
        if (input.newDeadline) cohort.day13DeadlineAt = input.newDeadline;
        cohort.acceptingUntil = input.acceptingUntil ?? null;
        cohort.updatedAt = new Date();
        return clone(cohort);
      },

      reconcileDeadlines: async (now = new Date()) => {
        const closed: string[] = [];
        for (const cohort of this.db.cohorts) {
          if (needsDeadlineReconciliation(cohort, now)) {
            cohort.status = 'closed';
            cohort.closedAt = now;
            cohort.closureType = 'deadline';
            cohort.updatedAt = now;
            closed.push(cohort.id);
          }
        }
        return { closed };
      },

      approveIdeaDefinition: async (ideaId, actor) => {
        const idea = this.db.ideas.find((i) => i.id === ideaId);
        if (!idea) throw new Error(`Idea ${ideaId} not found.`);
        idea.definitionStatus = 'approved';
        idea.definitionApprovedAt = new Date();
        idea.definitionApprovedBy = actor;
        idea.updatedAt = new Date();
        return clone(idea);
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
            whatsappLink: null,
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

      /** Mirrors the Postgres behaviour: idempotent, additive, never deletes a learner. */
      importLearnerAllocation: async (cohortId, groups): Promise<LearnerAllocationResult> => {
        await this.ready;
        const result: LearnerAllocationResult = {
          teamsCreated: 0,
          teamsMatched: 0,
          learnersAdded: 0,
          learnersUpdated: 0,
          learnersUnchanged: 0,
          whatsappLinksSet: 0,
          departed: [],
          failed: [],
        };

        for (const group of groups) {
          let team = this.db.teams.find(
            (t) => t.cohortId === cohortId && t.groupNumber === group.groupNumber,
          );

          if (!team) {
            team = {
              id: newId(),
              cohortId,
              groupNumber: group.groupNumber,
              leadName: null,
              leadEmail: null,
              leadPhone: '',
              whatsappLink: group.whatsappLink,
              status: 'active',
              importedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            this.db.teams.push(team);
            result.teamsCreated += 1;
            if (group.whatsappLink) result.whatsappLinksSet += 1;
          } else {
            result.teamsMatched += 1;
            // A blank Link column in a later sheet must not erase a link.
            if (group.whatsappLink && group.whatsappLink !== team.whatsappLink) {
              team.whatsappLink = group.whatsappLink;
              result.whatsappLinksSet += 1;
            }
          }

          const members = this.db.teamMembers.filter((m) => m.teamId === team!.id);
          const byEmail = new Map(
            members.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m] as const),
          );
          let order = members.length;

          for (const learner of group.learners) {
            const key = learner.email.toLowerCase();
            const match = byEmail.get(key);
            if (!match) {
              this.db.teamMembers.push({
                id: newId(),
                teamId: team.id,
                fullName: learner.name,
                email: learner.email,
                contribution: '',
                displayOrder: order,
                isActive: true,
              });
              order += 1;
              result.learnersAdded += 1;
              continue;
            }
            if (match.fullName !== learner.name) {
              match.fullName = learner.name;
              match.isActive = true;
              result.learnersUpdated += 1;
            } else {
              result.learnersUnchanged += 1;
            }
            byEmail.delete(key);
          }

          for (const left of byEmail.values()) {
            result.departed.push({
              teamId: team.id,
              groupNumber: group.groupNumber,
              name: left.fullName,
              email: left.email ?? '',
            });
          }
        }

        return result;
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

      generateAccessCodes: async ({ cohortId, teamIds, regenerate }): Promise<GeneratedAccessCodeRow[]> => {
        await this.ready;
        const rows: GeneratedAccessCodeRow[] = [];

        const targets = this.db.teams.filter(
          (t) => t.cohortId === cohortId && (!teamIds || teamIds.includes(t.id)),
        );

        for (const team of targets) {
          const existing = this.db.accessCodes.find((c) => c.teamId === team.id && !c.revokedAt);
          // Without an explicit regenerate, only teams missing a code get one —
          // so pressing the button twice never invalidates working codes.
          if (existing && !regenerate) continue;

          const generated = await generateAccessCode();
          const nextVersion = (existing?.version ?? 0) + 1;

          if (existing) {
            existing.revokedAt = new Date();
            // Bumping the version invalidates every session under the old code.
            this.revokeSessionsForTeam(team.id, 'access code regenerated');
          }

          this.db.accessCodes.push({
            id: newId(),
            teamId: team.id,
            cohortId: team.cohortId,
            groupNumber: team.groupNumber,
            codeHash: generated.hash,
            version: nextVersion,
            createdAt: new Date(),
            revokedAt: null,
            lastVerifiedAt: null,
            verifyCount: 0,
          });

          rows.push({
            teamId: team.id,
            groupNumber: team.groupNumber,
            leadName: team.leadName,
            leadEmail: team.leadEmail,
            whatsappLink: team.whatsappLink,
            memberCount: this.db.teamMembers.filter((m) => m.teamId === team.id).length,
            // Returned once. Only the hash is stored.
            code: generated.formatted,
            regenerated: Boolean(existing),
          });
        }

        return rows;
      },

      listAccessCodeStatus: async (cohortId): Promise<AccessCodeStatus[]> => {
        await this.ready;
        return this.db.teams
          .filter((t) => t.cohortId === cohortId)
          .sort((a, b) => a.groupNumber - b.groupNumber)
          .map((team) => {
            const code = this.db.accessCodes
              .filter((c) => c.teamId === team.id)
              .sort((a, b) => b.version - a.version)[0];
            const lock = this.db.verificationAttempts.find(
              (a) => a.groupNumber === team.groupNumber && a.lockedUntil && a.lockedUntil > new Date(),
            );
            return {
              teamId: team.id,
              groupNumber: team.groupNumber,
              leadName: team.leadName,
              leadEmail: team.leadEmail,
              whatsappLink: team.whatsappLink,
              hasCode: Boolean(code && !code.revokedAt),
              version: code?.version ?? 0,
              createdAt: code?.createdAt ?? null,
              revokedAt: code?.revokedAt ?? null,
              lastVerifiedAt: code?.lastVerifiedAt ?? null,
              verifyCount: code?.verifyCount ?? 0,
              activeSessions: this.db.participantSessions.filter(
                (s) => s.teamId === team.id && !s.revokedAt && s.expiresAt > new Date(),
              ).length,
              lockedUntil: lock?.lockedUntil ?? null,
            };
          });
      },

      revokeAccessCode: async (teamId) => {
        await this.ready;
        this.db.accessCodes
          .filter((c) => c.teamId === teamId && !c.revokedAt)
          .forEach((c) => {
            c.revokedAt = new Date();
          });
        this.revokeSessionsForTeam(teamId, 'access revoked');
      },

      restoreAccessCode: async (teamId) => {
        await this.ready;
        // Restoring cannot resurrect the old plaintext — it issues a new code.
        const latest = this.db.accessCodes
          .filter((c) => c.teamId === teamId)
          .sort((a, b) => b.version - a.version)[0];
        if (latest) latest.revokedAt = null;
      },

      clearVerificationLockout: async (_cohortId, groupNumber) => {
        this.db.verificationAttempts
          .filter((a) => a.groupNumber === groupNumber)
          .forEach((a) => {
            a.attempts = 0;
            a.lockedUntil = null;
            a.windowStartedAt = new Date();
            a.updatedAt = new Date();
          });
      },
    };
  }

  /** Revoke every live session for a team. Used by regeneration and revocation. */
  private revokeSessionsForTeam(teamId: string, _reason: string): number {
    let revoked = 0;
    for (const session of this.db.participantSessions) {
      if (session.teamId === teamId && !session.revokedAt) {
        session.revokedAt = new Date();
        revoked += 1;
      }
    }
    return revoked;
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

      findByReceiptId: async (receiptId) => {
        const normalised = receiptId.trim().toUpperCase();
        const submission = this.db.submissions.find(
          (s) => (s.receiptId ?? '').toUpperCase() === normalised,
        );
        return submission ? clone(submission) : null;
      },

      listTeamActivity: async (submissionId) =>
        clone(
          this.db.teamActivity
            .filter((a) => a.submissionId === submissionId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        ),

      revokeTeamSessions: async (teamId) => this.revokeSessionsForTeam(teamId, 'admin revoked'),

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
        // Same rules as production: the attempt comes from the job, and one
        // run per viewport per attempt replaces rather than accumulates.
        const job = this.db.jobs.find((j: AssessmentJob) => j.id === run.jobId);
        const attempt = job?.attemptCount ?? 1;

        const existing = this.db.browserRuns.find(
          (r) => r.jobId === run.jobId && r.attempt === attempt && r.viewport === run.viewport,
        );
        if (existing) {
          this.db.browserSteps = this.db.browserSteps.filter((s) => s.runId !== existing.id);
          Object.assign(existing, clone(run), { id: existing.id, attempt });
          steps.forEach((step) => {
            this.db.browserSteps.push({ ...clone(step), id: newId(), runId: existing.id });
          });
          return clone(existing);
        }

        const record: BrowserTestRun = { ...clone(run), id: newId(), attempt };
        this.db.browserRuns.push(record);
        steps.forEach((step) => {
          this.db.browserSteps.push({ ...clone(step), id: newId(), runId: record.id });
        });
        return clone(record);
      },

      listBrowserRuns: async (jobId) =>
        clone(
          this.db.browserRuns
            .filter((r) => {
              if (r.jobId !== jobId) return false;
              // Only the current attempt reaches judging.
              const job = this.db.jobs.find((j: AssessmentJob) => j.id === jobId);
              return r.attempt === (job?.attemptCount ?? 1);
            })
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

      /*
       * Demo mode holds evidence in memory, and still refuses to record it
       * before it exists.
       *
       * The shape is identical to production on purpose: ticket, upload,
       * confirm-with-verification. A demo that recorded evidence optimistically
       * would show a success the real path would refuse.
       */
      createEvidenceUploadTicket: async ({ jobId, kind, filename, workerId }) => {
        await this.ready;
        const job = this.db.jobs.find((j: AssessmentJob) => j.id === jobId);
        if (!job) return { ok: false, error: 'Unknown job.' };

        const submission = this.db.submissions.find((s) => s.id === job.submissionId);
        if (!submission || submission.cohortId !== job.cohortId) {
          return { ok: false, error: 'Unknown job.' };
        }

        // Same rule as production: a new authorisation needs a live lease this
        // worker owns.
        const live = job.claimedBy === workerId && job.leaseExpiresAt && job.leaseExpiresAt > new Date();
        if (!live) {
          return { ok: false, error: 'This worker does not hold a live lease on that job.' };
        }

        let target;
        try {
          target = evidenceTarget(
            { cohortId: job.cohortId, submissionId: job.submissionId, jobId: job.id },
            kind,
            filename,
          );
        } catch {
          return { ok: false, error: 'Could not derive an evidence path for this job.' };
        }

        return {
          ok: true,
          uploadUrl: `/api/demo-upload/${encodeURIComponent(target.bucket)}/${encodeURIComponent(target.storagePath)}`,
          bucket: target.bucket,
          storagePath: target.storagePath,
          maxBytes: EVIDENCE_MAX_BYTES[kind],
          expiresInSeconds: EVIDENCE_UPLOAD_TTL_SECONDS,
          contentType: EVIDENCE_CONTENT_TYPES[kind],
          attempt: job.attemptCount,
        };
      },

      confirmEvidenceUpload: async ({ jobId, kind, bucket, storagePath, workerId, attempt, runId, stepId }) => {
        await this.ready;
        const job = this.db.jobs.find((j: AssessmentJob) => j.id === jobId);
        if (!job) return { ok: false, error: 'Unknown job.' };

        // An expired lease may still finish its upload; a superseded attempt
        // may not.
        if (job.attemptCount !== attempt) {
          return {
            ok: false,
            error: `This upload belongs to attempt ${attempt}; the job is now on attempt ${job.attemptCount}.`,
          };
        }

        if (job.claimedBy && job.claimedBy !== workerId && job.leaseExpiresAt && job.leaseExpiresAt > new Date()) {
          return { ok: false, error: 'This job is now leased by another worker.' };
        }

        const owner = { cohortId: job.cohortId, submissionId: job.submissionId, jobId: job.id };
        if (!evidencePathBelongsTo(storagePath, bucket, owner, kind)) {
          return { ok: false, error: 'That evidence path does not belong to this job.' };
        }

        const bytes = this.demoEvidenceBytes.get(`${bucket}/${storagePath}`);
        if (!bytes) {
          return { ok: false, error: 'The upload did not finish. Nothing has been recorded.' };
        }

        let alreadyRecorded = false;
        if (kind === 'trace' && runId) {
          const run = this.db.browserRuns.find((r) => r.id === runId && r.jobId === jobId);
          if (!run) return { ok: false, error: 'That browser run does not belong to this job.' };
          alreadyRecorded = run.tracePath === storagePath;
          run.tracePath = storagePath;
        } else if (kind === 'screenshot' && stepId) {
          const step = this.db.browserSteps.find((s) => s.id === stepId);
          const run = step ? this.db.browserRuns.find((r) => r.id === step.runId && r.jobId === jobId) : null;
          if (!step || !run) return { ok: false, error: 'That step does not belong to this job.' };
          alreadyRecorded = step.screenshotPath === storagePath;
          step.screenshotPath = storagePath;
        }

        return { ok: true, bucket, storagePath, byteSize: bytes.byteLength, alreadyRecorded };
      },

      getEvidenceObject: async ({ kind, id }) => {
        await this.ready;
        const run =
          kind === 'trace'
            ? this.db.browserRuns.find((r) => r.id === id)
            : (() => {
                const step = this.db.browserSteps.find((s) => s.id === id);
                return step ? this.db.browserRuns.find((r) => r.id === step.runId) : undefined;
              })();
        if (!run) return null;

        const path =
          kind === 'trace'
            ? run.tracePath
            : (this.db.browserSteps.find((s) => s.id === id)?.screenshotPath ?? null);
        if (!path) return null;

        const job = this.db.jobs.find((j: AssessmentJob) => j.id === run.jobId);
        if (!job) return null;

        const owner = { cohortId: job.cohortId, submissionId: job.submissionId, jobId: job.id };
        const bucket = EVIDENCE_BUCKETS[kind];
        if (!evidencePathBelongsTo(path, bucket, owner, kind)) return null;
        return { bucket, storagePath: path, ...owner };
      },

      /*
       * The worker's own read, in memory.
       *
       * Same fields as production and, more importantly, the same absences: no
       * rank, no shortlist, no audit trail. Demo mode must not be able to show
       * the pipeline something the real one cannot see.
       */
      getJudgingInput: async (submissionId) => {
        await this.ready;
        const submission = this.db.submissions.find((s) => s.id === submissionId);
        if (!submission) return null;

        const team = this.db.teams.find((t) => t.id === submission.teamId);
        const cohort = this.db.cohorts.find((c) => c.id === submission.cohortId);
        if (!team || !cohort) return null;

        const job = this.db.jobs.find((j: AssessmentJob) => j.submissionId === submissionId);

        return clone({
          submission,
          team,
          members: this.db.teamMembers.filter((m) => m.teamId === team.id),
          cohort,
          idea: this.db.ideas.find((i: CohortIdea) => i.id === submission.ideaId) ?? null,
          artifacts: this.db.artifacts.filter((a) => a.submissionId === submissionId),
          artifactAnalysis: job
            ? (this.db.artifactAnalyses.find((a) => a.jobId === job.id) ?? null)
            : null,
        });
      },

      supersedeSystemManualReview: async (submissionId, note) => {
        await this.ready;
        // Same rule as production: system observations are retired by a newer
        // attempt, a human's decision is not.
        let n = 0;
        for (const flag of this.db.manualReviewFlags) {
          if (flag.submissionId !== submissionId) continue;
          if (flag.status !== 'open' || flag.raisedBy !== 'system') continue;
          flag.status = 'resolved';
          flag.resolvedBy = 'system';
          flag.resolvedAt = new Date();
          flag.resolutionNote = note;
          n += 1;
        }
        return n;
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
              solution_usefulness: pick(entry, 'solution_usefulness'),
              ai_usefulness: pick(entry, 'ai_usefulness'),
              two_day_execution: pick(entry, 'two_day_execution'),
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
      loomUrl: null,
      deckUrl: null,
      loginRequired: false,
      coreTestSteps: [],
      safeSampleInputs: null,
      resetInstructions: null,
      knownLimitations: null,
      bugsFixed: [],
      deliberatelyExcluded: null,
      majorTradeoff: null,
      day12ToDay13Changes: null,
      whatGotWorking: null,
      mostImportantLearning: null,
      nextSevenDayPlan: null,
      builderStack: null,
      apisUsed: null,
      externalTemplates: null,
      version: 1,
      lastEditedBy: null,
      draftPayload: {},
      draftUpdatedAt: null,
      submittedAt: null,
      submittedByName: null,
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
