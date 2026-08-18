/**
 * The participant surface.
 *
 * Every method takes the SESSION TOKEN and derives the team from it. No method
 * accepts a submission id, a team id or an access code from a caller, so a
 * tampered request cannot address another team's record (threat model T1). The
 * capability is absent rather than guarded (ADR-010).
 *
 * The business rules are not re-implemented here. Rate limiting, window
 * evaluation, version checking and session validity all come from the same pure
 * functions the memory driver calls; this repository loads state, calls them,
 * and persists the outcome. Two implementations of a security rule is one too
 * many.
 */

import type {
  Cohort,
  CohortIdea,
  Submission,
  SubmissionArtifact,
  SubmissionDeclarations,
  Team,
  TeamActivity,
  TeamMember,
  ParticipantView,
} from '../../types';
import type {
  CreateSessionInput,
  CreatedSession,
  FinaliseResult,
  ParticipantReceipt,
  ParticipantStore,
  SaveDraftResult,
  VerifyTeamResult,
} from '../../store';
import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlDatabase } from '../client';
import { pathBelongsToSubmission, type StorageAdapter } from '../storage';
import { MAX_DECK_BYTES, looksLikePdf, validateDeckUpload } from '../../../schemas/submission';

/** The one bucket a participant may write to. Never taken from a request. */
const DECK_BUCKET = 'submission-decks';

/** Said when a session has gone, in the learner's words rather than the system's. */
const SESSION_GONE = 'Your session has expired. Sign in again to continue.';
import { ARTIFACT_NUMERIC_COLUMNS, json, mapMaybe, mapRow, mapRowWithNumbers, mapRows, mapRowsWithNumbers, parseJson } from '../rows';
import {
  GENERIC_VERIFICATION_ERROR,
  clearVerificationAttempts,
  evaluateVerificationAttempt,
  registerFailedVerification,
  verifyAccessCode,
} from '../../../security/access-code';
import {
  computeSessionExpiry,
  evaluateParticipantSession,
  generateParticipantSessionToken,
  hashParticipantSessionToken,
} from '../../../security/participant-session';
import { hashInviteToken } from '../../../security/crypto';
import { computeSubmissionWindow, evaluateParticipantPermissions } from '../../../domain/submission-window';
import { checkVersion } from '../../../domain/concurrency';
import { isSubmissionLate } from '../../../domain/deadline';
import { generateReceiptId } from '../../../domain/ids';
import { encryptSecret, parseEncryptionKey, serialiseEnvelope } from '../../../security/crypto';
import {
  mapSubmission,
  promoteDraftToColumns,
  SUBMISSION_COLUMNS,
  SUBMISSION_RETURNING,
} from './submission-shared';

const SESSION_ENDED = 'Your session has ended. Sign in again to continue.';

export interface ParticipantDeps {
  db: SqlDatabase;
  /** Where deck bytes actually go. Without it an upload can only be recorded, not stored. */
  storage: StorageAdapter;
  /** Keys the session-token hash. A leaked table alone must not be usable. */
  sessionSecret?: string;
  credentialKey: string;
  credentialKeyVersion: number;
}

interface ResolvedSession {
  sessionId: string;
  editorName: string;
  team: Team;
  cohort: Cohort;
  submission: Submission;
}

export function buildParticipantStore(deps: ParticipantDeps): ParticipantStore {
  const { db, storage } = deps;

  /**
   * Resolve a session token to its team, or null.
   *
   * Null for missing, expired, revoked and code-rotated alike — the caller
   * turns that into one message, never into a reason.
   */
  async function resolve(token: string): Promise<ResolvedSession | null> {
    if (!token) return null;
    const hash = hashParticipantSessionToken(token, deps.sessionSecret);

    const { rows } = await db.query(
      `select s.id, s.team_id, s.cohort_id, s.editor_name,
              s.expires_at, s.revoked_at, s.access_code_version,
              ac.version as current_code_version
         from participant_sessions s
         left join team_access_codes ac
           on ac.team_id = s.team_id and ac.revoked_at is null
        where s.session_token_hash = $1`,
      [hash],
    );
    if (rows.length === 0) return null;

    const row = rows[0] as {
      id: string;
      team_id: string;
      cohort_id: string;
      editor_name: string;
      expires_at: Date;
      revoked_at: Date | null;
      access_code_version: number;
      current_code_version: number | null;
    };

    // A revoked code has no live row, so `current_code_version` is null and the
    // comparison fails — which is what makes revocation sign everyone out.
    const validity = evaluateParticipantSession(
      {
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        accessCodeVersion: Number(row.access_code_version),
      },
      row.current_code_version === null ? -1 : Number(row.current_code_version),
    );
    if (!validity.valid) return null;

    const teamRows = await db.query('select * from teams where id = $1', [row.team_id]);
    const team = mapMaybe<Team>(teamRows.rows);
    if (!team) return null;

    const cohort = await loadCohort(db, row.cohort_id);
    if (!cohort) return null;

    const submission = await ensureSubmission(db, cohort.id, team.id);

    // Best-effort: a failed activity stamp must never fail the read that
    // triggered it.
    await db
      .query('update participant_sessions set last_active_at = now() where id = $1', [row.id])
      .catch(() => undefined);

    return { sessionId: row.id, editorName: row.editor_name, team, cohort, submission };
  }

  /**
   * Record an artifact.
   *
   * A local function rather than an object method so `uploadDeck` can call
   * it directly: the bytes must be stored first and the row written through
   * exactly this path, so the two can never diverge.
   */
  async function attachArtifactImpl(
    token: string,
    artifact: Omit<SubmissionArtifact, 'id' | 'submissionId' | 'createdAt'>,
  ): Promise<SubmissionArtifact | null> {
      const resolved = await resolve(token);
      if (!resolved) return null;
      const { cohort, submission, team, editorName } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      if (!permissions.canEdit) return null;

      return db.transaction(async (tx) => {
        // One deck and one demo video per submission — replace, never append.
        if (artifact.kind === 'deck_pdf' || artifact.kind === 'demo_video') {
          await tx.query(
            'delete from submission_artifacts where submission_id = $1 and kind = $2',
            [submission.id, artifact.kind],
          );
        }

        const { rows } = await tx.query(
          `insert into submission_artifacts
             (submission_id, kind, storage_bucket, storage_path, original_filename,
              mime_type, byte_size, checksum_sha256, external_url, upload_completed_at,
              is_accessible, last_checked_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           returning *`,
          [
            submission.id,
            artifact.kind,
            artifact.storageBucket,
            artifact.storagePath,
            artifact.originalFilename,
            artifact.mimeType,
            artifact.byteSize,
            artifact.checksumSha256,
            artifact.externalUrl,
            artifact.uploadCompletedAt,
            artifact.isAccessible,
            artifact.lastCheckedAt,
          ],
        );

        await tx.query(
          `insert into team_activity (submission_id, team_id, kind, editor_name)
           values ($1, $2, $3, $4)`,
          [
            submission.id,
            team.id,
            artifact.kind === 'deck_pdf' ? 'deck_replaced' : 'demo_link_saved',
            editorName,
          ],
        );

        return mapRowWithNumbers<SubmissionArtifact>(rows[0] as Record<string, unknown>, ARTIFACT_NUMERIC_COLUMNS);
      });
    }

  return {
    // ----------------------------------------------------------------------
    // Entry
    // ----------------------------------------------------------------------

    async verifyTeamAccess({ groupNumber, code, ipHash }): Promise<VerifyTeamResult> {
      const now = new Date();

      // Rate limiting is keyed on hashed IP AND group number, so one hostile
      // client cannot lock out a legitimate team, and one team's fumbling
      // cannot lock out an office behind a shared connection.
      const existing = await db.query(
        `select attempts, window_started_at, locked_until
           from verification_attempts
          where ip_hash = $1 and group_number = $2`,
        [ipHash, groupNumber],
      );
      const state =
        existing.rows.length > 0
          ? {
              attempts: Number((existing.rows[0] as { attempts: number }).attempts),
              windowStartedAt: (existing.rows[0] as { window_started_at: Date }).window_started_at,
              lockedUntil: (existing.rows[0] as { locked_until: Date | null }).locked_until,
            }
          : null;

      const decision = evaluateVerificationAttempt(state, now);
      if (!decision.allowed) {
        return {
          ok: false,
          reason: 'rate_limited',
          message: `Too many attempts. Try again in ${Math.ceil(decision.retryAfterSeconds / 60)} minute(s), or contact the Outskill programme team.`,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      }

      const recordFailure = async (cohortId: string | null) => {
        const next = registerFailedVerification(state, now);
        await db.query(
          `insert into verification_attempts
             (cohort_id, group_number, ip_hash, attempts, window_started_at, locked_until)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (ip_hash, group_number) do update
             set attempts = excluded.attempts,
                 window_started_at = excluded.window_started_at,
                 locked_until = excluded.locked_until,
                 cohort_id = coalesce(excluded.cohort_id, verification_attempts.cohort_id)`,
          [cohortId, groupNumber, ipHash, next.attempts, next.windowStartedAt, next.lockedUntil],
        );
      };

      // One query for team and code together. Every failure below returns the
      // SAME message, so the form cannot be used to discover which group
      // numbers exist: unknown group, withdrawn team, no code, revoked code and
      // wrong code are indistinguishable from outside.
      //
      // Scoped to the cohort a learner could actually be submitting to. Group
      // numbers restart at 1 for every cohort, so "group 901" is ambiguous the
      // moment a second cohort exists — and this query previously took whichever
      // row Postgres returned first. A returning learner would then have their
      // code checked against a stranger's team and be refused entry to their own
      // hackathon, with a message that gave them nothing to act on.
      const { rows } = await db.query(
        `select t.id as team_id, t.cohort_id, ac.id as code_id, ac.code_hash,
                case when c.status in ('open', 'paused') then 0 else 1 end as precedence
           from teams t
           join cohorts c on c.id = t.cohort_id
           left join team_access_codes ac
             on ac.team_id = t.id and ac.revoked_at is null
          where t.group_number = $1
            and t.status = 'active'
            and c.status <> 'archived'
          order by precedence, c.created_at desc`,
        [groupNumber],
      );

      if (rows.length === 0) {
        await recordFailure(null);
        return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
      }

      type Candidate = {
        team_id: string;
        cohort_id: string;
        code_id: string | null;
        code_hash: string | null;
        precedence: number;
      };
      const candidates = rows as Candidate[];
      const best = Number(candidates[0]!.precedence);
      const atBest = candidates.filter((row) => Number(row.precedence) === best);

      // Two teams with the same group number and equal claim to it. Refusing is
      // the only safe answer: signing somebody into a coin-flip team would give
      // them edit access to another cohort's submission.
      if (atBest.length > 1) {
        await recordFailure(atBest[0]!.cohort_id);
        return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
      }

      const found = atBest[0]!;

      if (!found.code_id || !found.code_hash) {
        await recordFailure(found.cohort_id);
        return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
      }

      if (!(await verifyAccessCode(code, found.code_hash))) {
        await recordFailure(found.cohort_id);
        return { ok: false, reason: 'invalid', message: GENERIC_VERIFICATION_ERROR };
      }

      // Success clears the counter, so a team that fumbled and then succeeded
      // is not left one attempt away from a lockout.
      const cleared = clearVerificationAttempts(now);
      await db.query(
        `update verification_attempts
            set attempts = $3, window_started_at = $4, locked_until = null
          where ip_hash = $1 and group_number = $2`,
        [ipHash, groupNumber, cleared.attempts, cleared.windowStartedAt],
      );
      await db.query(
        `update team_access_codes
            set last_verified_at = now(), verify_count = verify_count + 1
          where id = $1`,
        [found.code_id],
      );

      return { ok: true, teamId: found.team_id, cohortId: found.cohort_id, groupNumber };
    },

    async createSession(input: CreateSessionInput): Promise<CreatedSession> {
      // A session is only ever minted for a team that has a live access code.
      // Without this, a caller that reached this method by another route could
      // obtain a session for a team whose code was revoked.
      const { rows } = await db.query(
        `select t.id, t.cohort_id, ac.version
           from teams t
           join team_access_codes ac
             on ac.team_id = t.id and ac.revoked_at is null
          where t.id = $1 and t.status = 'active'`,
        [input.teamId],
      );
      if (rows.length === 0) {
        throw new Error('That team cannot be opened. It has no live access code, or it is withdrawn.');
      }

      const team = rows[0] as { id: string; cohort_id: string; version: number };
      const cohort = await loadCohort(db, team.cohort_id);
      if (!cohort) throw new Error('That team belongs to a cohort that no longer exists.');

      const window = computeSubmissionWindow(cohort);
      const expiresAt = computeSessionExpiry(window.effectiveDeadline);
      const { token } = generateParticipantSessionToken();

      await db.query(
        `insert into participant_sessions
           (team_id, cohort_id, session_token_hash, editor_name, editor_role,
            access_code_version, expires_at, ip_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          team.id,
          team.cohort_id,
          hashParticipantSessionToken(token, deps.sessionSecret),
          input.editorName,
          input.editorRole,
          Number(team.version),
          expiresAt,
          input.ipHash,
        ],
      );

      return { token, expiresAt };
    },

    async resolveSession(token: string): Promise<ParticipantView | null> {
      const resolved = await resolve(token);
      if (!resolved) return null;
      const { team, cohort, submission, editorName } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);

      const [members, artifacts, declarations, ideas, credentials, activity] = await Promise.all([
        db.query('select * from team_members where team_id = $1 order by display_order', [team.id]),
        db.query('select * from submission_artifacts where submission_id = $1 order by created_at', [
          submission.id,
        ]),
        db.query('select * from submission_declarations where submission_id = $1', [submission.id]),
        db.query(
          'select * from cohort_ideas where cohort_id = $1 and is_active order by display_order',
          [cohort.id],
        ),
        db.query(
          'select 1 from submission_credentials where submission_id = $1 and deleted_at is null',
          [submission.id],
        ),
        db.query(
          'select * from team_activity where submission_id = $1 order by created_at desc limit 8',
          [submission.id],
        ),
      ]);

      return {
        // Only the cohort fields a participant may see. Nothing about judging
        // configuration, rubric or shortlist target reaches this object.
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
        members: mapRows<TeamMember>(members.rows),
        submission,
        artifacts: mapRowsWithNumbers<SubmissionArtifact>(artifacts.rows, ARTIFACT_NUMERIC_COLUMNS),
        declarations: mapMaybe<SubmissionDeclarations>(declarations.rows),
        ideas: ideas.rows.map(mapIdea),
        hasStoredCredentials: credentials.rows.length > 0,
        canEdit: permissions.canEdit,
        canSubmit: permissions.canSubmit,
        windowMessage: permissions.reason,
        effectiveDeadline: permissions.window.effectiveDeadline,
        editorName,
        recentActivity: mapRows<TeamActivity>(activity.rows),
      };
    },

    async endSession(token: string) {
      if (!token) return;
      // Signs out this browser only. Other members keep their own sessions.
      await db.query(
        'update participant_sessions set revoked_at = now() where session_token_hash = $1 and revoked_at is null',
        [hashParticipantSessionToken(token, deps.sessionSecret)],
      );
    },

    async resolveInviteTeam(token) {
      const { rows } = await db.query(
        `select t.id, t.group_number
           from team_invites i
           join teams t on t.id = i.team_id
          where i.token_hash = $1
            and i.revoked_at is null
            and (i.expires_at is null or i.expires_at > now())`,
        [hashInviteToken(token)],
      );
      if (rows.length === 0) return null;
      const row = rows[0] as { id: string; group_number: number };
      return { teamId: row.id, groupNumber: Number(row.group_number) };
    },

    async redeemInviteToken(token, editor): Promise<CreatedSession | null> {
      const { rows } = await db.query(
        `update team_invites
            set last_accessed_at = now(), access_count = access_count + 1
          where token_hash = $1
            and revoked_at is null
            and (expires_at is null or expires_at > now())
          returning team_id`,
        [hashInviteToken(token)],
      );
      if (rows.length === 0) return null;

      try {
        return await this.createSession({
          teamId: (rows[0] as { team_id: string }).team_id,
          editorName: editor.name,
          editorRole: editor.role,
          ipHash: null,
        });
      } catch {
        // A live invite for a team with no live access code. Indistinguishable
        // from an unknown invite, deliberately.
        return null;
      }
    },

    // ----------------------------------------------------------------------
    // Editing
    // ----------------------------------------------------------------------

    async saveDraft(token, draft, expectedVersion): Promise<SaveDraftResult> {
      const resolved = await resolve(token);
      if (!resolved) return { ok: false, error: SESSION_ENDED };
      const { cohort, submission, editorName } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      if (!permissions.canEdit) return { ok: false, error: permissions.reason };

      const check = checkVersion({ expectedVersion, currentVersion: submission.version });
      if (!check.ok) {
        return {
          ok: false,
          conflict: { currentVersion: check.currentVersion, message: check.message },
          submission,
        };
      }

      /**
       * Merge the incoming steps over the stored draft. Never replace it.
       *
       * This used to write `draft` wholesale, so a caller saving one step
       * destroyed every other step's payload. The form always posts all six
       * steps, which hid it completely — until a partial save was made, and
       * then a submission silently lost its declarations, its team details and
       * every answer that lives in the payload rather than in a column.
       *
       * Merged per step rather than deeply: a step is saved as a unit, and a
       * deep merge would make clearing a single field impossible.
       */
      const storedPayload = (submission.draftPayload ?? {}) as Record<string, unknown>;
      const mergedDraft = { ...storedPayload, ...(draft as Record<string, unknown>) };

      const promoted = promoteDraftToColumns({ ...submission, draftPayload: mergedDraft });

      // The version predicate is in the WHERE clause, not only in the check
      // above. Two teammates saving in the same instant both pass the read but
      // only one matches the row — the database is the arbiter, not a race
      // between two application reads.
      const { rows } = await db.query(
        `update submissions
            set draft_payload = coalesce(draft_payload, '{}'::jsonb) || $3::jsonb,
                draft_updated_at = now(),
                version = version + 1,
                last_edited_by = $4,
                idea_id = $5, product_name = $6, primary_user = $7, exact_problem = $8,
                one_sentence_promise = $9, brief_description = $10, why_ai_necessary = $11,
                differentiation = $12, must_have_workflow = $13, should_have_features = $14,
                excluded_features = $15, product_url = $16, login_required = $17,
                core_test_steps = $18, safe_sample_inputs = $19, reset_instructions = $20,
                known_limitations = $21, bugs_fixed = $22, deliberately_excluded = $23,
                major_tradeoff = $24, day12_to_day13_changes = $25, most_important_learning = $26,
                next_seven_day_plan = $27, builder_stack = $28, apis_used = $29,
                external_templates = $30
          where id = $1 and version = $2
          returning ${SUBMISSION_RETURNING}`,
        [
          submission.id,
          expectedVersion,
          // Only the incoming steps. `||` merges them over what is stored, so
          // the merge is done by the database rather than from a copy that
          // another writer may already have superseded.
          json(draft),
          editorName,
          promoted.ideaId,
          promoted.productName,
          promoted.primaryUser,
          promoted.exactProblem,
          promoted.oneSentencePromise,
          promoted.briefDescription,
          promoted.whyAiNecessary,
          promoted.differentiation,
          promoted.mustHaveWorkflow,
          promoted.shouldHaveFeatures,
          promoted.excludedFeatures,
          promoted.productUrl,
          promoted.loginRequired,
          json(promoted.coreTestSteps),
          promoted.safeSampleInputs,
          promoted.resetInstructions,
          promoted.knownLimitations,
          json(promoted.bugsFixed),
          promoted.deliberatelyExcluded,
          promoted.majorTradeoff,
          promoted.day12ToDay13Changes,
          promoted.mostImportantLearning,
          promoted.nextSevenDayPlan,
          promoted.builderStack,
          promoted.apisUsed,
          promoted.externalTemplates,
        ],
      );

      if (rows.length === 0) {
        // Lost the race between the read and the write.
        const current = await ensureSubmission(db, cohort.id, submission.teamId);
        const stale = checkVersion({ expectedVersion, currentVersion: current.version });
        return {
          ok: false,
          conflict: {
            currentVersion: current.version,
            message: stale.ok ? 'Another team member updated this submission.' : stale.message,
          },
          submission: current,
        };
      }

      return { ok: true, submission: mapSubmission(rows[0] as Record<string, unknown>) };
    },

    async finaliseSubmission(token, context): Promise<FinaliseResult> {
      const resolved = await resolve(token);
      if (!resolved) return { ok: false, error: SESSION_ENDED };
      const { cohort, submission, team, editorName } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      if (!permissions.canSubmit) return { ok: false, error: permissions.reason };

      return db.transaction(async (tx) => {
        // Re-read under a row lock. Two concurrent final submits both pass the
        // checks above; only one gets past this, and the other sees a locked
        // submission rather than minting a second receipt.
        const locked = await tx.query(
          `select ${SUBMISSION_COLUMNS} from submissions s where s.id = $1 for update`,
          [submission.id],
        );
        const current = mapSubmission(locked.rows[0] as Record<string, unknown>);

        if (current.receiptId && current.status === 'locked') {
          return { ok: false, error: 'This submission has already been finalised.' };
        }

        const idea = await tx.query(
          'select is_active from cohort_ideas where id = $1',
          [current.ideaId],
        );
        if (idea.rows.length === 0 || !(idea.rows[0] as { is_active: boolean }).is_active) {
          return {
            ok: false,
            error:
              'The selected product idea is no longer available for this cohort. Choose an approved idea.',
          };
        }

        const deck = await tx.query(
          `select 1 from submission_artifacts
            where submission_id = $1 and kind = 'deck_pdf' and upload_completed_at is not null`,
          [current.id],
        );
        if (deck.rows.length === 0) {
          return { ok: false, error: 'Upload your pitch deck as a PDF before submitting.' };
        }

        const video = await tx.query(
          `select 1 from submission_artifacts
            where submission_id = $1 and kind = 'demo_video' and external_url is not null`,
          [current.id],
        );
        if (video.rows.length === 0) {
          return { ok: false, error: 'Add your demo video link before submitting.' };
        }
        if (!current.productUrl) {
          return { ok: false, error: 'Add your live product URL before submitting.' };
        }

        const now = new Date();
        // Immutable: `coalesce` keeps any receipt id already minted, so a
        // reopened-and-resubmitted entry keeps the id the team was given.
        const receiptId = current.receiptId ?? generateReceiptId(cohort.code, team.groupNumber);

        // Compare-and-set, not just the row lock above.
        //
        // `for update` serialises concurrent transactions on real Postgres, but
        // relying on it alone makes correctness depend on the connection model:
        // anything that lets two calls share a session — a single-connection
        // engine, a pooler quirk, a future refactor — would let both through.
        // The `status <> 'locked'` predicate makes the write itself decide, so
        // exactly one caller can ever match, on any engine.
        const claimed = await tx.query(
          `update submissions
              set status = 'locked',
                  submitted_at = $2,
                  submitted_by_name = $3,
                  locked_at = $2,
                  version = version + 1,
                  receipt_id = coalesce(receipt_id, $4)
            where id = $1 and status <> 'locked'
            returning id`,
          [current.id, now, editorName, receiptId],
        );
        if (claimed.rows.length === 0) {
          // Another final submit won the race between the read and this write.
          return { ok: false, error: 'This submission has already been finalised.' };
        }

        await tx.query(
          `update submission_declarations
              set accepted_at = $2, accepted_ip_hash = $3
            where submission_id = $1`,
          [current.id, now, context.ipHash],
        );

        await tx.query(
          `insert into submission_events (submission_id, event_type, actor_type, detail)
           values ($1, 'final_submitted', 'participant', $2)`,
          [current.id, json({ receiptId, by: editorName })],
        );
        await tx.query(
          `insert into team_activity (submission_id, team_id, kind, editor_name)
           values ($1, $2, 'final_submitted', $3)`,
          [current.id, team.id, editorName],
        );

        return { ok: true, receiptId };
      });
    },

    /**
     * Store a pitch deck: the bytes first, the record second.
     *
     * Ordering is the whole point. If the upload throws, no artifact row is
     * written and the learner is told the upload failed — which is recoverable.
     * The reverse leaves a submission that claims to have a deck nobody can
     * open, and that is only discovered after the deadline.
     */
    async uploadDeck(token, input) {
      const resolved = await resolve(token);
      if (!resolved) return null;

      const permissions = evaluateParticipantPermissions(resolved.cohort, resolved.submission.status);
      if (!permissions.canEdit) return null;

      const path = `${resolved.cohort.id}/${resolved.submission.id}/pitch-deck.pdf`;

      // Throws on failure, so the artifact row below is unreachable unless the
      // object is genuinely in the bucket.
      await storage.upload('submission-decks', path, input.bytes, input.mimeType);

      return attachArtifactImpl(token, {
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
     * Authorise one upload, to one path.
     *
     * The declared size and type are checked here only to refuse the obvious
     * cheaply — they come from the browser and are therefore claims. The bucket
     * enforces the truth: `submission-decks` is capped at 25 MB and restricted
     * to `application/pdf` in migration 0003, so a client that lies about
     * either is rejected by Storage before a byte is kept.
     */
    async createDeckUploadTicket(token, input) {
      const resolved = await resolve(token);
      if (!resolved) return { ok: false, error: SESSION_GONE };

      const permissions = evaluateParticipantPermissions(resolved.cohort, resolved.submission.status);
      if (!permissions.canEdit) return { ok: false, error: permissions.reason };

      const declared = validateDeckUpload({
        name: input.originalFilename,
        type: input.mimeType,
        size: input.byteSize,
      });
      if (!declared.ok) return { ok: false, error: declared.message };

      /*
       * A fresh path per attempt.
       *
       * The old implementation wrote every deck to `pitch-deck.pdf` and
       * overwrote in place, so an upload that died halfway through a
       * replacement destroyed the deck the team already had. Staging each
       * attempt under its own name means the previous object is still there to
       * fall back to, and is only removed once the new one has been checked.
       *
       * The second path segment stays the submission id: the storage policy in
       * 0003 reads it, so a path shaped any other way is refused by Postgres
       * as well as by the check below.
       */
      const nonce = randomUUID();
      const storagePath = `${resolved.cohort.id}/${resolved.submission.id}/pending-${nonce}.pdf`;

      try {
        const ticket = await storage.createSignedUploadUrl(DECK_BUCKET, storagePath);
        return {
          ok: true,
          uploadUrl: ticket.url,
          uploadToken: ticket.token,
          storagePath,
          maxBytes: MAX_DECK_BYTES,
        };
      } catch {
        return { ok: false, error: 'Could not start the upload. Try again in a moment.' };
      }
    },

    /**
     * Accept an upload only if the bucket agrees it happened.
     *
     * Every failure below removes the object that was just written, so a
     * refused upload leaves nothing behind and the team's previous deck
     * untouched.
     */
    async confirmDeckUpload(token, input) {
      const resolved = await resolve(token);
      if (!resolved) return { ok: false, error: SESSION_GONE };

      const permissions = evaluateParticipantPermissions(resolved.cohort, resolved.submission.status);
      if (!permissions.canEdit) return { ok: false, error: permissions.reason };

      const { cohort, submission } = resolved;

      /*
       * The path is the browser's only input, so it is the only thing that can
       * be pointed somewhere it should not be. It has to sit under this
       * submission's own prefix — anything else is another team's object, or an
       * attempt to attach one.
       */
      const expectedPrefix = `${cohort.id}/${submission.id}/`;
      if (!input.storagePath.startsWith(expectedPrefix) || input.storagePath.includes('..')) {
        return { ok: false, error: 'That upload does not belong to this submission.' };
      }
      if (!pathBelongsToSubmission(input.storagePath, submission.id)) {
        return { ok: false, error: 'That upload does not belong to this submission.' };
      }

      const discard = async () => {
        try {
          await storage.remove(DECK_BUCKET, [input.storagePath]);
        } catch {
          // Best effort. An object nobody has a row for is unreachable through
          // the product; leaving one behind is untidy, not unsafe.
        }
      };

      // Does it exist, and how big is it really?
      let stat: { byteSize: number; mimeType: string | null } | null;
      try {
        stat = await storage.statObject(DECK_BUCKET, input.storagePath);
      } catch {
        return { ok: false, error: 'Could not confirm the upload. Try again.' };
      }
      if (!stat) {
        // The upload never arrived, or was cut off before Storage kept it.
        return { ok: false, error: 'The upload did not finish. Choose the file and try again.' };
      }
      if (stat.byteSize <= 0) {
        await discard();
        return { ok: false, error: 'The uploaded file is empty.' };
      }
      if (stat.byteSize > MAX_DECK_BYTES) {
        await discard();
        return {
          ok: false,
          error: `The pitch deck must be ${Math.round(MAX_DECK_BYTES / 1024 / 1024)} MB or smaller.`,
        };
      }

      // A PDF signature, read from the object itself rather than from whatever
      // content type the browser announced.
      let head: Uint8Array | null;
      try {
        head = await storage.downloadHead(DECK_BUCKET, input.storagePath, 8);
      } catch {
        head = null;
      }
      if (!head || !looksLikePdf(head)) {
        await discard();
        return {
          ok: false,
          error: 'That file is not a PDF. Export your deck as a PDF and upload it again.',
        };
      }

      // What the team had before, so it can be cleaned up — but only after the
      // replacement is safely recorded.
      const { rows: previous } = await db.query<{ storage_path: string | null }>(
        `select storage_path from submission_artifacts
          where submission_id = $1 and kind = 'deck_pdf' and storage_bucket = $2`,
        [submission.id, DECK_BUCKET],
      );

      const artifact = await attachArtifactImpl(token, {
        kind: 'deck_pdf',
        storageBucket: DECK_BUCKET,
        storagePath: input.storagePath,
        originalFilename: input.originalFilename,
        mimeType: 'application/pdf',
        byteSize: stat.byteSize,
        checksumSha256: null,
        externalUrl: null,
        uploadCompletedAt: new Date(),
        isAccessible: true,
        lastCheckedAt: new Date(),
      });

      if (!artifact) {
        // The row could not be written. The new object is useless without it,
        // and the old deck is still recorded and still in the bucket.
        await discard();
        return { ok: false, error: 'Could not record the upload. Your previous deck is unchanged.' };
      }

      const stale = previous
        .map((row) => row.storage_path)
        .filter((path): path is string => Boolean(path) && path !== input.storagePath);
      if (stale.length > 0) {
        try {
          await storage.remove(DECK_BUCKET, stale);
        } catch {
          // The row already points at the new object, so the old one is
          // orphaned rather than dangerous.
        }
      }

      return { ok: true, artifact };
    },

    attachArtifact: attachArtifactImpl,


    async removeArtifact(token, artifactId) {
      const resolved = await resolve(token);
      if (!resolved) return;
      const { cohort, submission } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      if (!permissions.canEdit) return;

      // Scoped to this session's own submission. An artifact id belonging to
      // another team matches nothing.
      await db.query('delete from submission_artifacts where id = $1 and submission_id = $2', [
        artifactId,
        submission.id,
      ]);
    },

    async storeCredentials(token, values) {
      const resolved = await resolve(token);
      if (!resolved) return;
      const { cohort, submission } = resolved;

      const permissions = evaluateParticipantPermissions(cohort, submission.status);
      if (!permissions.canEdit) return;

      // Encrypted before it reaches the database. The draft blob is plain JSON,
      // which is why the caller splits credentials out of it.
      //
      // Each field is encrypted under its OWN IV, carried inside a
      // self-contained envelope. The table's single `iv`/`auth_tag` columns are
      // deliberately left null: one shared IV across three plaintexts under the
      // same key is a real AES-GCM break, not a tidiness question.
      const key = parseEncryptionKey(deps.credentialKey);
      const seal = (value: string | undefined): Buffer | null =>
        value && value.length > 0
          ? Buffer.from(serialiseEnvelope(encryptSecret(value, key, deps.credentialKeyVersion)), 'utf8')
          : null;

      await db.query(
        `insert into submission_credentials
           (submission_id, username_ciphertext, password_ciphertext,
            login_instructions_ciphertext, key_version)
         values ($1,$2,$3,$4,$5)
         on conflict (submission_id) do update
           set username_ciphertext = excluded.username_ciphertext,
               password_ciphertext = excluded.password_ciphertext,
               login_instructions_ciphertext = excluded.login_instructions_ciphertext,
               key_version = excluded.key_version,
               deleted_at = null,
               updated_at = now()`,
        [
          submission.id,
          seal(values.username),
          seal(values.password),
          seal(values.loginInstructions),
          deps.credentialKeyVersion,
        ],
      );
    },

    async listParticipantResources(cohortId) {
      // Participant-visible only. Assessment material is never recorded as a
      // resource, so there is no path from here to internal documents.
      const { rows } = await db.query(
        `select * from resource_documents
          where is_participant_visible
            and (cohort_id = $1 or cohort_id is null)
          order by display_order, title`,
        [cohortId],
      );
      return mapRows(rows);
    },

    async recordActivity(token, kind, section) {
      const resolved = await resolve(token);
      if (!resolved) return;
      await db.query(
        `insert into team_activity (submission_id, team_id, kind, editor_name, section)
         values ($1, $2, $3, $4, $5)`,
        [
          resolved.submission.id,
          resolved.team.id,
          kind,
          resolved.editorName,
          section ?? null,
        ],
      );
    },

    async getReceipt(token): Promise<ParticipantReceipt | null> {
      const resolved = await resolve(token);
      if (!resolved) return null;
      const { submission, cohort, team } = resolved;

      // Null while still a draft: there is nothing to receipt.
      if (!submission.receiptId || !submission.submittedAt) return null;

      const idea = submission.ideaId
        ? await db.query('select title from cohort_ideas where id = $1', [submission.ideaId])
        : null;

      return {
        cohortName: cohort.name,
        cohortTimezone: cohort.timezone,
        groupNumber: team.groupNumber,
        productName: submission.productName ?? '',
        ideaTitle:
          idea && idea.rows.length > 0 ? (idea.rows[0] as { title: string }).title : '',
        submittedByName: submission.submittedByName ?? '',
        submittedAt: submission.submittedAt,
        receiptId: submission.receiptId,
      };
    },
  };
}

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

export async function loadCohort(client: SqlClient, id: string): Promise<Cohort | null> {
  const { rows } = await client.query(
    `select c.*, rv.version as rubric_version
       from cohorts c join rubric_versions rv on rv.id = c.rubric_version_id
      where c.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const cohort = mapRow<Cohort & { rubricVersionId?: string }>(rows[0] as Record<string, unknown>);
  delete cohort.rubricVersionId;
  return {
    ...cohort,
    assessmentConfig: parseJson(cohort.assessmentConfig, {} as Cohort['assessmentConfig']),
  };
}

function mapIdea(row: Record<string, unknown>): CohortIdea {
  const idea = mapRow<CohortIdea>(row);
  return {
    ...idea,
    minimumCoreFlow: parseJson<string[]>(idea.minimumCoreFlow, []),
    expectedEntities: (idea.expectedEntities as string[] | null) ?? [],
  };
}

/**
 * The team's submission, creating an empty draft on first access.
 *
 * `on conflict do nothing` then re-read, rather than check-then-insert: two
 * teammates opening the portal at the same moment would otherwise both see no
 * row and both insert one.
 */
export async function ensureSubmission(
  client: SqlClient,
  cohortId: string,
  teamId: string,
): Promise<Submission> {
  await client.query(
    `insert into submissions (cohort_id, team_id, status)
     values ($1, $2, 'draft')
     on conflict (cohort_id, team_id) do nothing`,
    [cohortId, teamId],
  );
  const { rows } = await client.query(
    `select ${SUBMISSION_COLUMNS} from submissions s where s.cohort_id = $1 and s.team_id = $2`,
    [cohortId, teamId],
  );
  return mapSubmission(rows[0] as Record<string, unknown>);
}

export { isSubmissionLate };
