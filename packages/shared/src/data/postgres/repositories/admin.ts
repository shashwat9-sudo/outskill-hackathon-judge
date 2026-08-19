/**
 * Admin authentication and cohorts.
 *
 * There is exactly one admin account, enforced by a `singleton` column with a
 * unique constraint in `0001` — the database refuses a second row rather than
 * relying on application code to remember.
 */

import type { AdminAccount, AdminSession, Cohort, CohortIdea } from '../../types';
import type { AdminAuthStore, CohortStore } from '../../store';
import type { CohortStatus } from '../../../domain/status';
import {
  assessCohortDeletion,
  confirmationMatches,
  type CohortDependencies,
} from '../../../domain/cohort-deletion';
import {
  checkCohortExclusivity,
  isLearnerFacing,
  resolveLearnerFacingCohort,
  type CohortSummary,
} from '../../../domain/cohort-exclusivity';
import { RowNotFoundError, type SqlClient, type SqlDatabase } from '../client';
import { buildUpdate, json, mapMaybe, mapRow, parseJson } from '../rows';

/** Raised when a cohort holds work and must be archived rather than deleted. */
export class CohortNotDeletableError extends Error {
  override readonly name = 'CohortNotDeletableError';
  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(message);
  }
}

/** Raised when opening a cohort would leave two facing learners at once. */
export class CohortExclusivityError extends Error {
  override readonly name = 'CohortExclusivityError';
  constructor(
    message: string,
    readonly blockedBy: CohortSummary | null,
  ) {
    super(message);
  }
}

// --------------------------------------------------------------------------
// Admin authentication
// --------------------------------------------------------------------------

export function buildAdminAuthStore(db: SqlDatabase): AdminAuthStore {
  return {
    async getAdminAccount() {
      const { rows } = await db.query('select * from admin_account limit 1');
      return mapMaybe<AdminAccount>(rows);
    },

    async createAdminAccount(username, passwordHash) {
      // `on conflict (singleton) do nothing` makes bootstrap idempotent: two
      // web instances starting at once cannot produce two accounts, and a
      // restart cannot reset the password of an account already in use.
      const { rows } = await db.query(
        `insert into admin_account (username, password_hash, password_updated_at)
         values ($1, $2, now())
         on conflict (singleton) do nothing
         returning *`,
        [username, passwordHash],
      );
      if (rows.length > 0) return mapRow<AdminAccount>(rows[0] as Record<string, unknown>);

      // Someone else won the race. Return the account that exists rather than
      // failing — the caller wanted "an admin exists", and one does.
      const existing = await db.query('select * from admin_account limit 1');
      const account = mapMaybe<AdminAccount>(existing.rows);
      if (!account) throw new Error('Admin account could not be created or read back.');
      return account;
    },

    async updateAdminLockout(state) {
      await db.query(
        'update admin_account set failed_attempts = $1, locked_until = $2, updated_at = now()',
        [state.failedAttempts, state.lockedUntil],
      );
    },

    async recordSuccessfulLogin() {
      await db.query(
        `update admin_account
            set last_login_at = now(), failed_attempts = 0, locked_until = null, updated_at = now()`,
      );
    },

    async rotateCredentials(input) {
      // Rotation revokes every session in the same transaction. A rotated
      // password that left existing sessions alive would not be a rotation.
      await db.transaction(async (tx) => {
        const patch: Record<string, unknown> = {};
        if (input.username !== undefined) patch.username = input.username;
        if (input.passwordHash !== undefined) {
          patch.passwordHash = input.passwordHash;
          patch.passwordUpdatedAt = new Date();
        }

        const update = buildUpdate(patch);
        if (update) {
          await tx.query(
            `update admin_account set ${update.clause}, updated_at = now()`,
            update.values,
          );
        }
        await tx.query('update admin_sessions set revoked_at = now() where revoked_at is null');
      });
    },

    async createSession(input) {
      const { rows } = await db.query(
        `insert into admin_sessions
           (admin_id, session_token_hash, csrf_token, expires_at, rotated_from, ip_hash, user_agent_hash)
         values ((select id from admin_account limit 1), $1, $2, $3, $4, $5, $6)
         returning *`,
        [
          input.sessionTokenHash,
          input.csrfToken,
          input.expiresAt,
          input.rotatedFrom,
          input.ipHash,
          input.userAgentHash,
        ],
      );
      return mapRow<AdminSession>(rows[0] as Record<string, unknown>);
    },

    async getSessionByHash(hash) {
      const { rows } = await db.query(
        'select * from admin_sessions where session_token_hash = $1',
        [hash],
      );
      return mapMaybe<AdminSession>(rows);
    },

    async revokeSession(sessionId) {
      await db.query(
        'update admin_sessions set revoked_at = now() where id = $1 and revoked_at is null',
        [sessionId],
      );
    },

    async revokeAllSessions() {
      await db.query('update admin_sessions set revoked_at = now() where revoked_at is null');
    },
  };
}

// --------------------------------------------------------------------------
// Cohorts
// --------------------------------------------------------------------------

/**
 * `Cohort.rubricVersion` is the human-readable version string, but the column
 * is a foreign key to `rubric_versions`. Every read joins to resolve it, so the
 * entity shape stays identical to the memory driver's.
 */
const COHORT_SELECT = `
  select c.*, rv.version as rubric_version
    from cohorts c
    join rubric_versions rv on rv.id = c.rubric_version_id`;

function mapCohort(row: Record<string, unknown>): Cohort {
  const cohort = mapRow<Cohort & { rubricVersionId?: string }>(row);
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
    // `text[]` arrives as a real array from pg; the fallback covers a null column.
    expectedEntities: (idea.expectedEntities as string[] | null) ?? [],
  };
}

async function resolveRubricVersionId(tx: SqlClient, version: string): Promise<string> {
  const { rows } = await tx.query('select id from rubric_versions where version = $1', [version]);
  if (rows.length === 0) {
    throw new Error(
      `Rubric version "${version}" does not exist. Bootstrap the rubric before creating a cohort.`,
    );
  }
  return (rows[0] as { id: string }).id;
}

export function buildCohortStore(db: SqlDatabase): CohortStore {
  return {
    async listCohorts() {
      const { rows } = await db.query(`${COHORT_SELECT} order by c.created_at desc`);
      return rows.map(mapCohort);
    },

    async getCohort(id) {
      const { rows } = await db.query(`${COHORT_SELECT} where c.id = $1`, [id]);
      return rows.length > 0 ? mapCohort(rows[0] as Record<string, unknown>) : null;
    },

    async getCohortByCode(code) {
      const { rows } = await db.query(`${COHORT_SELECT} where lower(c.code) = lower($1)`, [code]);
      return rows.length > 0 ? mapCohort(rows[0] as Record<string, unknown>) : null;
    },

    async findActiveCohort() {
      // Learner-facing cohorts first, and only if there is exactly ONE. Picking
      // between two by creation order is what produced the original bug: the
      // learner page and the admin shell each named a cohort nobody chose.
      const learnerFacing = await db.query(
        `${COHORT_SELECT} where c.status in ('open', 'paused')`,
      );
      const resolved = resolveLearnerFacingCohort(
        learnerFacing.rows.map((row) => mapCohort(row as Record<string, unknown>)),
      );
      if (resolved.cohort) return resolved.cohort;

      if (resolved.ambiguous) {
        // Refuse rather than guess. The admin surface surfaces this as a
        // warning; the learner page shows no cohort rather than the wrong one.
        return null;
      }

      // No learner-facing cohort. Fall back to the most recent non-archived one
      // so the admin shell and the entry page still have something to name.
      const { rows } = await db.query(
        `${COHORT_SELECT}
          where c.status <> 'archived'
          order by case c.status
                     when 'closed' then 0 when 'judging' then 1
                     when 'draft' then 2 when 'finalised' then 3 else 4 end,
                   c.created_at desc
          limit 1`,
      );
      return rows.length > 0 ? mapCohort(rows[0] as Record<string, unknown>) : null;
    },

    async listLearnerFacingCohorts() {
      const { rows } = await db.query(`${COHORT_SELECT} where c.status in ('open', 'paused')`);
      return rows.map((row) => mapCohort(row as Record<string, unknown>));
    },

    async createCohort(input) {
      return db.transaction(async (tx) => {
        const rubricVersionId = await resolveRubricVersionId(tx, input.rubricVersion);
        const { rows } = await tx.query(
          `insert into cohorts
             (name, code, description, timezone, day12_start_at, day13_deadline_at,
              shortlist_target, submission_instructions, rubric_version_id,
              assessment_config, status, closed_at, closure_type, accepting_until)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           returning *`,
          [
            input.name,
            input.code,
            input.description,
            input.timezone,
            input.day12StartAt,
            input.day13DeadlineAt,
            input.shortlistTarget,
            input.submissionInstructions,
            rubricVersionId,
            json(input.assessmentConfig),
            input.status,
            input.closedAt,
            input.closureType,
            input.acceptingUntil,
          ],
        );
        const created = mapRow<Cohort & { rubricVersionId?: string }>(
          rows[0] as Record<string, unknown>,
        );
        delete created.rubricVersionId;
        return {
          ...created,
          rubricVersion: input.rubricVersion,
          assessmentConfig: parseJson(created.assessmentConfig, input.assessmentConfig),
        };
      });
    },

    async updateCohort(id, patch) {
      const writable = { ...patch };
      // Derived on read and never written directly.
      delete (writable as Record<string, unknown>).rubricVersion;
      /*
       * Whether a cohort is synthetic is not editable through the admin API.
       *
       * It decides whether this cohort's contents may be sent to an external
       * provider under `synthetic_only`, so a patch that could set it would put
       * that decision behind any route that ends in `updateCohort` — including
       * a form post. Setting it is an operator action against the database, on
       * a cohort known to hold no learner work.
       */
      delete (writable as Record<string, unknown>).isSynthetic;
      delete (writable as Record<string, unknown>).id;
      delete (writable as Record<string, unknown>).createdAt;
      delete (writable as Record<string, unknown>).updatedAt;

      if (writable.assessmentConfig !== undefined) {
        (writable as Record<string, unknown>).assessmentConfig = json(writable.assessmentConfig);
      }

      const update = buildUpdate(writable, 2);
      if (update) {
        const { rowCount } = await db.query(
          `update cohorts set ${update.clause} where id = $1`,
          [id, ...update.values],
        );
        if (rowCount === 0) throw new RowNotFoundError('Cohort', id);
      }

      const cohort = await this.getCohort(id);
      if (!cohort) throw new RowNotFoundError('Cohort', id);
      return cohort;
    },

    async setCohortStatus(id, status: CohortStatus) {
      // Read and write in one transaction. Two operators opening two cohorts at
      // the same moment must not both pass the check.
      if (isLearnerFacing(status)) {
        await db.transaction(async (tx) => {
          const all = await tx.query<CohortSummary>(
            `select id, name, code, status::text as status from cohorts for update`,
          );
          const target = all.rows.find((c) => c.id === id);
          if (!target) throw new RowNotFoundError('Cohort', id);

          const check = checkCohortExclusivity(target, status, all.rows);
          if (!check.allowed) throw new CohortExclusivityError(check.reason, check.blockedBy);

          await tx.query(
            `update cohorts set status = $2::cohort_status where id = $1`,
            [id, status],
          );
        });
        const cohort = await this.getCohort(id);
        if (!cohort) throw new RowNotFoundError('Cohort', id);
        return cohort;
      }

      const { rowCount } = await db.query(
        // Both casts are required: $2 is an enum value in one clause and
        // compared to text in the other, and Postgres refuses to deduce a
        // single type for a parameter used two ways.
        `update cohorts
            set status = $2::cohort_status,
                finalised_at = case when $2::text = 'finalised' then now() else finalised_at end
          where id = $1`,
        [id, status],
      );
      if (rowCount === 0) throw new RowNotFoundError('Cohort', id);
      const cohort = await this.getCohort(id);
      if (!cohort) throw new RowNotFoundError('Cohort', id);
      return cohort;
    },

    async closeSubmissions(id, closureType) {
      const { rowCount } = await db.query(
        `update cohorts
            set status = 'closed', closed_at = now(), closure_type = $2,
                -- A closure supersedes any temporary extension.
                accepting_until = null
          where id = $1`,
        [id, closureType],
      );
      if (rowCount === 0) throw new RowNotFoundError('Cohort', id);
      const cohort = await this.getCohort(id);
      if (!cohort) throw new RowNotFoundError('Cohort', id);
      return cohort;
    },

    async reopenSubmissions(id, input) {
      // Reopening makes the cohort learner-facing, so it needs the same check.
      await db.transaction(async (tx) => {
        const all = await tx.query<CohortSummary>(
          `select id, name, code, status::text as status from cohorts for update`,
        );
        const target = all.rows.find((c) => c.id === id);
        if (!target) throw new RowNotFoundError('Cohort', id);
        const check = checkCohortExclusivity(target, 'open', all.rows);
        if (!check.allowed) throw new CohortExclusivityError(check.reason, check.blockedBy);
      });

      const { rowCount } = await db.query(
        `update cohorts
            set status = 'open',
                closed_at = null,
                closure_type = null,
                day13_deadline_at = coalesce($2, day13_deadline_at),
                accepting_until = $3
          where id = $1`,
        [id, input.newDeadline ?? null, input.acceptingUntil ?? null],
      );
      if (rowCount === 0) throw new RowNotFoundError('Cohort', id);
      const cohort = await this.getCohort(id);
      if (!cohort) throw new RowNotFoundError('Cohort', id);
      return cohort;
    },

    async reconcileDeadlines(now = new Date()) {
      // Housekeeping only. Acceptance is decided per write from the server
      // clock, so a cohort this never reaches still refuses writes correctly.
      const { rows } = await db.query(
        `update cohorts
            set status = 'closed', closed_at = $1, closure_type = 'deadline'
          where status = 'open'
            and coalesce(accepting_until, day13_deadline_at) < $1
          returning id`,
        [now],
      );
      return { closed: rows.map((r) => (r as { id: string }).id) };
    },

    async getCohortDependencies(id) {
      // One statement, so every count is from the same instant. Counting in
      // sequence could let a submission arrive between two reads and produce a
      // "safe to delete" verdict for a cohort that no longer is.
      const { rows } = await db.query<Record<string, number>>(
        `select
           (select count(*)::int from teams where cohort_id = $1) as teams,
           (select count(*)::int from team_members m
              join teams t on t.id = m.team_id where t.cohort_id = $1) as team_members,
           (select count(*)::int from submissions where cohort_id = $1) as submissions,
           (select count(*)::int from submissions
             where cohort_id = $1 and status <> 'draft') as final_submissions,
           (select count(*)::int from submission_artifacts a
              join submissions s on s.id = a.submission_id where s.cohort_id = $1) as artifacts,
           (select count(*)::int from team_access_codes where cohort_id = $1) as access_codes,
           (select count(*)::int from participant_sessions where cohort_id = $1) as participant_sessions,
           (select count(*)::int from assessment_jobs where cohort_id = $1) as assessment_jobs,
           (select count(*)::int from category_scores c
              join assessment_jobs j on j.id = c.job_id where j.cohort_id = $1) as category_scores,
           (select count(*)::int from ranking_snapshots where cohort_id = $1) as ranking_snapshots,
           (select count(*)::int from final_selections where cohort_id = $1) as final_selections,
           (select count(*)::int from audit_logs where cohort_id = $1) as audit_entries`,
        [id],
      );
      const row = rows[0] as Record<string, unknown>;
      return mapRow<CohortDependencies>(row);
    },

    async archiveCohort(id, actor) {
      return db.transaction(async (tx) => {
        const current = await tx.query<{ status: string; name: string }>(
          'select status::text as status, name from cohorts where id = $1 for update',
          [id],
        );
        if (current.rows.length === 0) throw new RowNotFoundError('Cohort', id);

        // Archiving ends learner access. Sessions are revoked explicitly rather
        // than left to expire — a team should not keep editing a retired cohort
        // for the remainder of their session lifetime.
        await tx.query(
          'update participant_sessions set revoked_at = now() where cohort_id = $1 and revoked_at is null',
          [id],
        );
        await tx.query(`update cohorts set status = 'archived' where id = $1`, [id]);

        await tx.query(
          `insert into audit_logs (actor_type, actor_ref, action, entity_type, entity_id, cohort_id, after)
           values ('shared-admin', $2, 'cohort.archived', 'cohort', $1, $1, $3)`,
          [id, actor, json({ previousStatus: current.rows[0]?.status })],
        );
      }).then(async () => {
        const cohort = await this.getCohort(id);
        if (!cohort) throw new RowNotFoundError('Cohort', id);
        return cohort;
      });
    },

    async deleteCohortPermanently(id, input) {
      const cohort = await this.getCohort(id);
      if (!cohort) throw new RowNotFoundError('Cohort', id);

      // Re-checked here, not merely in the UI. A caller reaching this method by
      // any other route must meet the same bar.
      const dependencies = await this.getCohortDependencies(id);
      const assessment = assessCohortDeletion(cohort.name, dependencies);

      if (assessment.verdict !== 'deletable') {
        throw new CohortNotDeletableError(
          `“${cohort.name}” holds work and cannot be deleted: ${assessment.blockers.join(' ')} ` +
            'Archive it instead — archiving preserves everything and removes it from operational views.',
          assessment.blockers,
        );
      }
      if (!confirmationMatches(input.confirmationPhrase, cohort.name)) {
        throw new CohortNotDeletableError(
          `Type the cohort name exactly to confirm: ${cohort.name}`,
          [],
        );
      }

      return db.transaction(async (tx) => {
        // The audit entry is written BEFORE the delete. `audit_logs.cohort_id`
        // cascades, so a record written afterwards would be removed with the
        // cohort — and a deletion nobody can see afterwards is the one kind this
        // system must not perform.
        await tx.query(
          `insert into audit_logs (actor_type, actor_ref, action, entity_type, entity_id, after)
           values ('shared-admin', $1, 'cohort.deleted_permanently', 'cohort', $2, $3)`,
          [
            input.actor,
            id,
            json({
              name: cohort.name,
              code: cohort.code,
              removed: assessment.willRemove,
              // Recorded so the trail explains what was gone at the time.
              dependencies,
            }),
          ],
        );

        // Foreign keys cascade from cohorts to teams, ideas, access codes and
        // sessions. Stated rather than assumed, because a silent cascade is how
        // more gets removed than anyone expected.
        await tx.query('delete from cohorts where id = $1', [id]);

        return { deleted: true as const, removed: assessment.willRemove };
      });
    },

    async approveIdeaDefinition(ideaId, actor) {
      const { rows } = await db.query(
        `update cohort_ideas
            set definition_status = 'approved',
                definition_approved_at = now(),
                definition_approved_by = $2
          where id = $1
          returning *`,
        [ideaId, actor],
      );
      if (rows.length === 0) throw new RowNotFoundError('Idea', ideaId);
      return mapIdea(rows[0] as Record<string, unknown>);
    },

    async listIdeas(cohortId, options) {
      const { rows } = await db.query(
        `select * from cohort_ideas
          where cohort_id = $1 and ($2::boolean or is_active)
          order by display_order, title`,
        [cohortId, options?.includeInactive ?? false],
      );
      return rows.map(mapIdea);
    },

    async getIdea(id) {
      const { rows } = await db.query('select * from cohort_ideas where id = $1', [id]);
      return rows.length > 0 ? mapIdea(rows[0] as Record<string, unknown>) : null;
    },

    async createIdea(input) {
      const { rows } = await db.query(
        `insert into cohort_ideas
           (cohort_id, title, slug, description, target_user, expected_use_case,
            minimum_core_flow, expected_entities, ai_opportunity, allowed_scope,
            unsafe_interpretations, display_order, is_active,
            definition_status, definition_approved_at, definition_approved_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         returning *`,
        [
          input.cohortId,
          input.title,
          input.slug,
          input.description,
          input.targetUser,
          input.expectedUseCase,
          json(input.minimumCoreFlow),
          input.expectedEntities,
          input.aiOpportunity,
          input.allowedScope,
          input.unsafeInterpretations,
          input.displayOrder,
          input.isActive,
          input.definitionStatus,
          input.definitionApprovedAt,
          input.definitionApprovedBy,
        ],
      );
      return mapIdea(rows[0] as Record<string, unknown>);
    },

    async updateIdea(id, patch) {
      return db.transaction(async (tx) => {
        const current = await tx.query('select * from cohort_ideas where id = $1', [id]);
        if (current.rows.length === 0) throw new RowNotFoundError('Idea', id);
        const before = mapIdea(current.rows[0] as Record<string, unknown>);

        const writable: Record<string, unknown> = { ...patch };
        delete writable.id;
        delete writable.createdAt;
        delete writable.updatedAt;
        if (writable.minimumCoreFlow !== undefined) {
          writable.minimumCoreFlow = json(writable.minimumCoreFlow);
        }

        // Changing what judging measures against un-approves the definition.
        // Enforced here rather than in each caller: an approval that survives an
        // edit is worse than no approval, because it looks reviewed (ADR-025).
        if (changesExpandedDefinition(before, patch)) {
          writable.definitionStatus = 'draft';
          writable.definitionApprovedAt = null;
          writable.definitionApprovedBy = null;
        }

        const update = buildUpdate(writable, 2);
        if (!update) return before;

        const { rows } = await tx.query(
          `update cohort_ideas set ${update.clause} where id = $1 returning *`,
          [id, ...update.values],
        );
        return mapIdea(rows[0] as Record<string, unknown>);
      });
    },

    async deleteIdea(id) {
      // Soft delete: a past submission must keep resolving its idea.
      await db.query('update cohort_ideas set is_active = false where id = $1', [id]);
    },

    async cloneIdeas(fromCohortId, toCohortId) {
      const { rows } = await db.query(
        `insert into cohort_ideas
           (cohort_id, title, slug, description, target_user, expected_use_case,
            minimum_core_flow, expected_entities, ai_opportunity, allowed_scope,
            unsafe_interpretations, display_order, is_active,
            definition_status, definition_approved_at, definition_approved_by)
         select $2, title, slug, description, target_user, expected_use_case,
                minimum_core_flow, expected_entities, ai_opportunity, allowed_scope,
                unsafe_interpretations, display_order, is_active,
                -- A clone carries the source's wording but not its approval: the
                -- new cohort's operator has not read it yet.
                'draft', null, null
           from cohort_ideas
          where cohort_id = $1 and is_active
          returning *`,
        [fromCohortId, toCohortId],
      );
      return rows.map(mapIdea);
    },
  };
}

/**
 * The fields that make an idea's definition "expanded" rather than sourced.
 *
 * Title and description come from the approved catalogue. Everything here is
 * Outskill's interpretation, and it is what test-plan generation reads.
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

function changesExpandedDefinition(current: CohortIdea, patch: Partial<CohortIdea>): boolean {
  return EXPANDED_DEFINITION_FIELDS.some(
    (field) => field in patch && JSON.stringify(patch[field]) !== JSON.stringify(current[field]),
  );
}
