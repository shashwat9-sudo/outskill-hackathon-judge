'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  assertDisqualificationAllowed,
  buildAccessCodeCsv,
  buildLearnerMessage,
  buildImportPreview,
  buildInviteCsv,
  formatInTimezone,
  JUDGING_UNAVAILABLE_MESSAGE,
  canTransitionCohort,
  storeCapabilities,
  parseLearnerSheet,
  parseTeamImportCsv,
  selectForConsistencyReview,
  timezoneLabel,
  toCsv,
  validateReopen,
  validateFinalSelection,
  type CohortStatus,
} from '@ohj/shared';
import { assertDistributableBaseUrl } from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';
import {
  assertCsrf,
  auditAdminAction,
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  rotateAdminCredentials,
} from './admin-auth';

/**
 * Admin server actions.
 *
 * Every action: requires a session, checks CSRF, performs the change, writes an
 * audit entry. The audit entry is not optional — a shared account can only be
 * held accountable through its trail (threat model T6).
 */

export interface AdminActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const ACTOR = 'shared-admin';

/**
 * Refuse an action that needs automated judging.
 *
 * Returns a result rather than throwing, so the operator sees an explanation in
 * the form they pressed rather than a server error page. Actions call this
 * BEFORE any state change — a cohort moved to `judging` with nothing assessing
 * it would leave teams unable to edit and nothing making progress.
 */
async function requireJudging(): Promise<AdminActionResult | null> {
  const store = await getStoreAsync();
  const { assessment, ranking } = storeCapabilities(store);
  return assessment && ranking ? null : { ok: false, error: JUDGING_UNAVAILABLE_MESSAGE };
}


// --------------------------------------------------------------------------
// Session
// --------------------------------------------------------------------------

export async function loginAction(formData: FormData): Promise<AdminActionResult> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const result = await loginAdmin(username, password);
  if (!result.ok) return { ok: false, error: result.error };
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  await logoutAdmin();
  redirect('/admin/login');
}

export async function rotateCredentialsAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const result = await rotateAdminCredentials({
    currentPassword: String(formData.get('currentPassword') ?? ''),
    newUsername: String(formData.get('newUsername') ?? '') || undefined,
    newPassword: String(formData.get('newPassword') ?? '') || undefined,
  });

  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    message:
      'Credentials rotated. Every signed-in session has been revoked — everyone will need to sign in again with the new password.',
  };
}

// --------------------------------------------------------------------------
// Cohorts
// --------------------------------------------------------------------------

export async function createCohortAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const env = getEnvConfig();

  const name = String(formData.get('name') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const deadline = String(formData.get('day13DeadlineAt') ?? '');
  const start = String(formData.get('day12StartAt') ?? '');

  if (!name || !code) return { ok: false, error: 'Name and code are both required.' };
  if (!deadline || !start) return { ok: false, error: 'Day 12 start and Day 13 deadline are both required.' };

  const day12StartAt = new Date(start);
  const day13DeadlineAt = new Date(deadline);
  if (Number.isNaN(day12StartAt.getTime()) || Number.isNaN(day13DeadlineAt.getTime())) {
    return { ok: false, error: 'Those dates could not be read.' };
  }
  if (day13DeadlineAt <= day12StartAt) {
    return { ok: false, error: 'The Day 13 deadline must be after the Day 12 start.' };
  }

  try {
    const cohort = await store.cohorts.createCohort({
      name,
      code,
      description: String(formData.get('description') ?? ''),
      timezone: String(formData.get('timezone') ?? env.DEFAULT_TIMEZONE),
      day12StartAt,
      day13DeadlineAt,
      shortlistTarget: Number(formData.get('shortlistTarget') ?? env.DEFAULT_SHORTLIST_TARGET),
      // A new cohort has never been closed and has no extension.
      closedAt: null,
      closureType: null,
      acceptingUntil: null,
      submissionInstructions: String(formData.get('submissionInstructions') ?? ''),
      rubricVersion: 'rubric-v2',
      assessmentConfig: {
        workerConcurrency: env.WORKER_CONCURRENCY,
        browserBudgetMs: env.BROWSER_TEST_BUDGET_MS,
        maxAttempts: env.JOB_MAX_ATTEMPTS,
        retryBackoffMs: 60_000,
        gracePeriodMs: 3_600_000,
        consistencyTopN: 20,
        lowConfidenceThreshold: 0.6,
        modelVersion: env.AI_MODEL ?? 'unset',
        promptVersion: 'assessment-prompts-v1',
      },
      status: 'draft',
    });

    // Seed the approved ideas so a new cohort is immediately usable.
    const existing = await store.cohorts.listCohorts();
    const source = existing.find((c) => c.id !== cohort.id);
    if (source) await store.cohorts.cloneIdeas(source.id, cohort.id);

    await auditAdminAction({
      action: 'cohort.created',
      entityType: 'cohort',
      entityId: cohort.id,
      cohortId: cohort.id,
      after: { name, code },
    });
    revalidatePath('/admin/cohorts');
    return { ok: true, message: `Cohort “${name}” created.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not create the cohort.' };
  }
}

/**
 * Archive a cohort.
 *
 * Deliberately NOT `setCohortStatusAction` with `archived`. That would set the
 * column and stop — leaving every participant session live against a retired
 * cohort until it expired on its own, and writing a generic status-change
 * entry instead of a record of what was archived.
 *
 * `archiveCohort` revokes those sessions and writes the archive record in one
 * transaction. The distinction is invisible on screen and matters entirely.
 *
 * Archiving preserves everything: submissions, receipts, artifacts, Storage
 * objects, audit history and any judging results. It is not deletion, and there
 * is deliberately no deletion control here — permanent deletion refuses a
 * cohort holding real work, and that refusal is worth more than a button.
 */
export async function archiveCohortAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();

  const cohortId = String(formData.get('cohortId') ?? '');
  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };

  const transition = canTransitionCohort(cohort.status, 'archived');
  if (!transition.allowed) {
    return {
      ok: false,
      error:
        `${transition.reason} Close submissions first — a cohort still open to learners cannot be retired underneath them.`,
    };
  }

  await store.cohorts.archiveCohort(cohortId, ACTOR);
  revalidatePath('/admin/cohorts');
  revalidatePath('/admin');

  return {
    ok: true,
    message:
      `Archived "${cohort.name}". Everything is kept — submissions, receipts, uploaded files, ` +
      'audit history and any judging results. Learner access has ended.',
  };
}

export async function setCohortStatusAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();

  const cohortId = String(formData.get('cohortId') ?? '');
  const status = String(formData.get('status') ?? '') as CohortStatus;

  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };

  const { canTransitionCohort } = await import('@ohj/shared');
  const transition = canTransitionCohort(cohort.status, status);
  if (!transition.allowed) return { ok: false, error: transition.reason };

  await store.cohorts.setCohortStatus(cohortId, status);
  await auditAdminAction({
    action: 'cohort.status_changed',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    before: { status: cohort.status },
    after: { status },
  });
  revalidatePath('/admin/cohorts');
  revalidatePath('/admin');
  return { ok: true, message: `Cohort is now ${status}.` };
}

// --------------------------------------------------------------------------
// Ideas
// --------------------------------------------------------------------------

export async function saveIdeaAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();

  const ideaId = String(formData.get('ideaId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');
  const lines = (value: string) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const patch = {
    title: String(formData.get('title') ?? '').trim(),
    slug: String(formData.get('slug') ?? '').trim(),
    description: String(formData.get('description') ?? ''),
    targetUser: String(formData.get('targetUser') ?? ''),
    expectedUseCase: String(formData.get('expectedUseCase') ?? ''),
    minimumCoreFlow: lines(String(formData.get('minimumCoreFlow') ?? '')),
    expectedEntities: lines(String(formData.get('expectedEntities') ?? '')),
    aiOpportunity: String(formData.get('aiOpportunity') ?? ''),
    allowedScope: String(formData.get('allowedScope') ?? ''),
    unsafeInterpretations: String(formData.get('unsafeInterpretations') ?? ''),
    displayOrder: Number(formData.get('displayOrder') ?? 0),
    isActive: formData.get('isActive') === 'on',
  };

  if (!patch.title || !patch.slug) return { ok: false, error: 'Title and slug are both required.' };

  try {
    if (ideaId) {
      await store.cohorts.updateIdea(ideaId, patch);
      await auditAdminAction({
        action: 'idea.updated',
        entityType: 'cohort_idea',
        entityId: ideaId,
        cohortId,
        after: { title: patch.title },
      });
    } else {
      // Expanded definitions start as a draft: they are our interpretation of
      // the source idea, and they influence real judging only once approved.
      const idea = await store.cohorts.createIdea({
        ...patch,
        cohortId,
        definitionStatus: 'draft',
        definitionApprovedAt: null,
        definitionApprovedBy: null,
      });
      await auditAdminAction({
        action: 'idea.created',
        entityType: 'cohort_idea',
        entityId: idea.id,
        cohortId,
        after: { title: patch.title },
      });
    }
    revalidatePath(`/admin/cohorts/${cohortId}/ideas`);
    return { ok: true, message: `Idea “${patch.title}” saved.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the idea.' };
  }
}

/**
 * Approve an expanded idea definition.
 *
 * Title and description come from the approved source catalogue and are always
 * usable. Everything else on an idea — the minimum core flow, the expected
 * entities, the AI opportunity, the allowed scope — is Outskill's interpretation
 * written here, and a test plan built from an unreviewed interpretation would
 * judge teams against something nobody agreed to. So those fields only influence
 * real judging once a human has read them and pressed this (ADR-025).
 */
export async function approveIdeaDefinitionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const ideaId = String(formData.get('ideaId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  const idea = await (await getStoreAsync()).cohorts.approveIdeaDefinition(ideaId, ACTOR);
  await auditAdminAction({
    action: 'idea.definition_approved',
    entityType: 'cohort_idea',
    entityId: ideaId,
    cohortId,
    after: { title: idea.title, definitionStatus: idea.definitionStatus },
  });

  revalidatePath(`/admin/cohorts/${cohortId}/ideas`);
  return {
    ok: true,
    message: `“${idea.title}” is approved. Test plans can now use its expanded definition.`,
  };
}

export async function deactivateIdeaAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const ideaId = String(formData.get('ideaId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  // Soft-delete: a past submission must keep resolving its idea.
  await (await getStoreAsync()).cohorts.deleteIdea(ideaId);
  await auditAdminAction({
    action: 'idea.deactivated',
    entityType: 'cohort_idea',
    entityId: ideaId,
    cohortId,
  });
  revalidatePath(`/admin/cohorts/${cohortId}/ideas`);
  return { ok: true, message: 'Idea deactivated. Existing submissions keep their reference to it.' };
}

// --------------------------------------------------------------------------
// Teams and invites
// --------------------------------------------------------------------------

export async function importTeamsAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const cohortId = String(formData.get('cohortId') ?? '');

  const file = formData.get('csv');
  const pasted = String(formData.get('csvText') ?? '');
  const text = file instanceof File && file.size > 0 ? await file.text() : pasted;

  if (!text.trim()) return { ok: false, error: 'Provide a CSV file or paste CSV text.' };

  const parsed = parseTeamImportCsv(text);
  if (parsed.rows.length === 0) {
    const detail = parsed.errors.map((e) => `Row ${e.row}: ${e.message}`).join(' ');
    return { ok: false, error: `No usable rows found. ${detail}` };
  }

  const result = await store.teams.importTeams(cohortId, parsed.rows);
  await auditAdminAction({
    action: 'teams.imported',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: { created: result.created.length, skipped: result.skipped.length },
  });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);

  const problems = [...parsed.errors.map((e) => `Row ${e.row}: ${e.message}`), ...result.skipped.map((s) => `Row ${s.row}: ${s.reason}`)];
  return {
    ok: true,
    message:
      `Imported ${result.created.length} team${result.created.length === 1 ? '' : 's'}.` +
      (problems.length > 0 ? ` Skipped ${problems.length}: ${problems.slice(0, 5).join('; ')}` : ''),
  };
}

/**
 * Import the learner allocation sheet.
 *
 * The browser shows a preview before this runs, but the sheet is parsed again
 * here from the raw text. The preview is a convenience for the operator, not a
 * source of truth — accepting a client-supplied list of groups would let anyone
 * with a session post arbitrary teams and learner emails.
 */
export async function importLearnerAllocationAction(
  formData: FormData,
): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const cohortId = String(formData.get('cohortId') ?? '');

  const file = formData.get('sheet');
  const pasted = String(formData.get('sheetText') ?? '');
  const text = file instanceof File && file.size > 0 ? await file.text() : pasted;
  if (!text.trim()) return { ok: false, error: 'Provide a sheet file or paste the rows.' };

  const parsed = parseLearnerSheet(text);
  if (parsed.error) return { ok: false, error: parsed.error };

  const existing = await store.teams.listTeams(cohortId);
  const preview = buildImportPreview(parsed, existing.map((t) => t.groupNumber));

  // Blockers are re-checked server-side. A learner in two groups would leave
  // one team silently short, and no database constraint can catch it.
  if (!preview.importable || preview.blockers.length > 0) {
    return {
      ok: false,
      error:
        preview.blockers.length > 0
          ? `Fix the sheet first. ${preview.blockers.join(' ')}`
          : 'No usable rows found in that sheet.',
    };
  }

  const result = await store.teams.importLearnerAllocation(
    cohortId,
    preview.groups.map((g) => ({
      groupNumber: g.groupNumber,
      whatsappLink: g.whatsappLink,
      learners: g.learners.map((l) => ({ name: l.name, email: l.email })),
    })),
  );

  await auditAdminAction({
    action: 'teams.allocation_imported',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: {
      teamsCreated: result.teamsCreated,
      teamsMatched: result.teamsMatched,
      learnersAdded: result.learnersAdded,
      learnersUpdated: result.learnersUpdated,
      departed: result.departed.length,
      failed: result.failed.length,
      rejectedRows: preview.rejected.length,
    },
  });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);

  const parts = [
    `${result.teamsCreated} team${result.teamsCreated === 1 ? '' : 's'} created`,
    `${result.teamsMatched} already existed`,
    `${result.learnersAdded} learner${result.learnersAdded === 1 ? '' : 's'} added`,
  ];
  if (result.learnersUpdated > 0) parts.push(`${result.learnersUpdated} name(s) corrected`);
  if (preview.rejected.length > 0) parts.push(`${preview.rejected.length} row(s) skipped`);
  // Reported, never applied: see importLearnerAllocation.
  if (result.departed.length > 0) {
    parts.push(
      `${result.departed.length} existing learner(s) were not in this sheet and were left in place`,
    );
  }
  if (result.failed.length > 0) {
    parts.push(
      `${result.failed.length} group(s) failed: ${result.failed
        .slice(0, 3)
        .map((f) => `group ${f.groupNumber} (${f.reason})`)
        .join('; ')}`,
    );
  }

  return { ok: true, message: `${parts.join('. ')}.` };
}

export async function regenerateInviteAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const teamId = String(formData.get('teamId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  await (await getStoreAsync()).teams.generateInvite(teamId);
  await auditAdminAction({
    action: 'invite.regenerated',
    entityType: 'team',
    entityId: teamId,
    cohortId,
  });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);
  return { ok: true, message: 'New invite issued. The previous link no longer works.' };
}

export async function revokeInviteAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const teamId = String(formData.get('teamId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  await (await getStoreAsync()).teams.revokeInvite(teamId);
  await auditAdminAction({ action: 'invite.revoked', entityType: 'team', entityId: teamId, cohortId });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);
  return { ok: true, message: 'Invite revoked.' };
}

/** Build the invite CSV for distribution through Outskill's own channel (ADR-024). */
export async function exportInvitesAction(cohortId: string): Promise<string> {
  await requireAdmin();
  const store = await getStoreAsync();
  const env = getEnvConfig();
  const teams = await store.teams.listTeams(cohortId);

  const { asDemoStore } = await import('@ohj/shared');
  const demo = asDemoStore(store);

  const rows = teams
    .map((team) => {
      const token = demo?.getDemoInviteToken(team.id) ?? null;
      return token
        ? {
            groupNumber: team.groupNumber,
            leadEmail: team.leadEmail,
            inviteUrl: `${env.APP_BASE_URL}/submit/${token}`,
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  await auditAdminAction({
    action: 'invites.exported',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: { count: rows.length },
  });
  return buildInviteCsv(rows);
}

// --------------------------------------------------------------------------
// Team access codes
// --------------------------------------------------------------------------

/**
 * Generate access codes.
 *
 * The plaintext exists for exactly one round trip: it is generated, returned to
 * this action, written into a CSV the operator downloads, and then it is gone.
 * Only the Argon2id hash is stored, and there is no column that could hold the
 * code — so "resend their code" is never an option, only "issue a new one".
 *
 * That is a deliberate trade. An operator who loses the sheet has to regenerate
 * for the affected teams, which is a minor inconvenience; a system that could
 * reprint every team's credential on demand is a much larger problem.
 */
/**
 * Issuing access codes.
 *
 * Plaintext exists for exactly as long as this function runs. Nothing stores
 * it, and there is no method to read a code back — only the Argon2id hash is
 * kept. So issuing and downloading cannot be separate steps: a code issued
 * without producing a file is a code nobody can ever be told.
 *
 * That is why each of these returns the sheet alongside the result, and why
 * there is no standalone "download the codes" button. The previous design had
 * one, and it worked by silently regenerating every code in the cohort —
 * meaning the only way to get a file for five newly imported teams was to
 * invalidate the codes of the ninety-five that already had one.
 */
export interface CodeSheetResult extends AdminActionResult {
  /** The sheet to download. Present only when codes were actually issued. */
  csv?: string;
  filename?: string;
  issued?: number;
  /**
   * The ready-to-send message, when exactly one code was issued.
   *
   * Only for the single-team case, which is the one where a coordinator is
   * reissuing to a team that lost its code and is about to paste into one
   * thread. For sixty-five it would be the wrong shape — that is what the file
   * is for.
   *
   * No new exposure: this is the same plaintext already inside the CSV in the
   * same response, and it is stored in neither.
   */
  singleMessage?: string;
}

async function issueCodes(
  formData: FormData,
  options: { regenerate: boolean; teamIds?: string[]; label: string },
): Promise<CodeSheetResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const cohortId = String(formData.get('cohortId') ?? '');
  const store = await getStoreAsync();
  const env = getEnvConfig();

  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'That cohort no longer exists.' };

  // Checked BEFORE the codes are generated. Generation is the only moment the
  // plaintext exists, so producing codes and then refusing to write the sheet
  // would strand every one of them.
  try {
    assertDistributableBaseUrl(env.APP_BASE_URL);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'APP_BASE_URL is not distributable.' };
  }

  const rows = await store.teams.generateAccessCodes({
    cohortId,
    teamIds: options.teamIds,
    regenerate: options.regenerate,
  });

  await auditAdminAction({
    action: options.regenerate ? 'access_codes.regenerated' : 'access_codes.generated',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    // Counts and group numbers only. A code must never reach the audit log.
    after: { count: rows.length, groups: rows.map((r) => r.groupNumber), reason: options.label },
  });

  revalidatePath(`/admin/cohorts/${cohortId}/teams`);

  if (rows.length === 0) {
    return {
      ok: true,
      issued: 0,
      message:
        'Nothing to do — every team already holds a live code. Use “Replace every code” if you need to rotate them.',
    };
  }

  const csv = buildAccessCodeCsv(
    rows.map((row) => ({
      groupNumber: row.groupNumber,
      leadName: row.leadName,
      leadEmail: row.leadEmail,
      whatsappLink: row.whatsappLink,
      memberCount: row.memberCount,
      code: row.code,
    })),
    `${env.APP_BASE_URL}/submit`,
  );

  const withoutLink = rows.filter((r) => !r.whatsappLink).length;
  const emptyTeams = rows.filter((r) => r.memberCount === 0).length;
  const notes: string[] = [];
  if (withoutLink > 0) notes.push(`${withoutLink} have no WhatsApp link in the sheet`);
  if (emptyTeams > 0) notes.push(`${emptyTeams} have no learners yet`);

  const single = rows.length === 1 ? rows[0]! : null;

  return {
    ok: true,
    issued: rows.length,
    csv,
    filename: `access-codes-${cohort.code}-${options.regenerate ? 'all' : 'new'}.csv`,
    ...(single
      ? {
          singleMessage: buildLearnerMessage({
            groupNumber: single.groupNumber,
            code: single.code,
            submitUrl: `${env.APP_BASE_URL}/submit`,
          }),
        }
      : {}),
    message:
      `Issued ${rows.length} code${rows.length === 1 ? '' : 's'}. The file has downloaded — it is the only copy.` +
      (notes.length > 0 ? ` Note: ${notes.join(', ')}.` : ''),
  };
}

/** The normal path after importing the allocation sheet. Disturbs nobody who already has a code. */
export async function issueMissingCodesAction(formData: FormData): Promise<CodeSheetResult> {
  return issueCodes(formData, { regenerate: false, label: 'issue missing' });
}

/** Rotates every code in the cohort and signs everyone out. Destructive on purpose. */
export async function rotateAllCodesAction(formData: FormData): Promise<CodeSheetResult> {
  return issueCodes(formData, { regenerate: true, label: 'rotate all' });
}

/** One team that lost their code. Only that team is signed out. */
export async function regenerateOneCodeAction(formData: FormData): Promise<CodeSheetResult> {
  const teamId = String(formData.get('teamId') ?? '');
  if (!teamId) return { ok: false, error: 'No team selected.' };
  return issueCodes(formData, { regenerate: true, teamIds: [teamId], label: 'regenerate one' });
}

export async function revokeAccessCodeAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const teamId = String(formData.get('teamId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  await (await getStoreAsync()).teams.revokeAccessCode(teamId);
  await auditAdminAction({
    action: 'access_code.revoked',
    entityType: 'team',
    entityId: teamId,
    cohortId,
  });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);
  return {
    ok: true,
    message: 'Access code revoked. Anyone editing under it has been signed out.',
  };
}

/**
 * Clear a verification lockout.
 *
 * A team that mistypes its code eight times locks itself out for fifteen
 * minutes. On the evening of a deadline that is fifteen minutes they do not
 * have, so an operator can end it immediately.
 */
export async function clearLockoutAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');
  const groupNumber = Number(formData.get('groupNumber') ?? 0);

  if (!Number.isInteger(groupNumber) || groupNumber < 1) {
    return { ok: false, error: 'Enter the group number whose lockout you want to clear.' };
  }

  await (await getStoreAsync()).teams.clearVerificationLockout(cohortId, groupNumber);
  await auditAdminAction({
    action: 'access_code.lockout_cleared',
    entityType: 'team',
    entityId: String(groupNumber),
    cohortId,
    after: { groupNumber },
  });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);
  return { ok: true, message: `Group ${groupNumber} can try again straight away.` };
}

// --------------------------------------------------------------------------
// Closing and reopening submissions
// --------------------------------------------------------------------------

/**
 * Close submissions by hand.
 *
 * Guarded by a typed confirmation rather than a dialog, because this is the
 * moment several hundred teams lose the ability to edit and an accidental
 * double-click must not be able to cause it.
 */
export async function closeSubmissionsAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const cohortId = String(formData.get('cohortId') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '').trim();

  if (confirmation !== 'CLOSE SUBMISSIONS') {
    return { ok: false, error: 'Type CLOSE SUBMISSIONS exactly to confirm.' };
  }

  const cohort = await (await getStoreAsync()).cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };

  await (await getStoreAsync()).cohorts.closeSubmissions(cohortId, 'manual');
  await auditAdminAction({
    action: 'cohort.closed',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    before: { status: cohort.status },
    after: { status: 'closed', closureType: 'manual' },
  });

  revalidatePath('/admin/cohorts');
  revalidatePath('/admin');
  return { ok: true, message: 'Submissions are closed. No team can edit or submit.' };
}

/**
 * Reopen submissions.
 *
 * After the official deadline this requires an extension. Without one the
 * cohort would show as open while rejecting every write — the most confusing
 * state this system could present to a team that has just been told they may
 * resubmit, so the shared validator refuses it rather than the UI hiding it.
 */
export async function reopenSubmissionsAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const cohortId = String(formData.get('cohortId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const acceptingUntilRaw = String(formData.get('acceptingUntil') ?? '').trim();

  const store = await getStoreAsync();
  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };

  let acceptingUntil: Date | null = null;
  if (acceptingUntilRaw) {
    acceptingUntil = new Date(acceptingUntilRaw);
    if (Number.isNaN(acceptingUntil.getTime())) {
      return { ok: false, error: 'That acceptance time could not be read.' };
    }
  }

  const validation = validateReopen(cohort, { reason, acceptingUntil });
  if (!validation.valid) return { ok: false, error: validation.problems.join(' ') };

  const updated = await store.cohorts.reopenSubmissions(cohortId, { reason, acceptingUntil });
  await auditAdminAction({
    action: 'cohort.reopened',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    before: { status: cohort.status },
    after: { status: 'open', reason, acceptingUntil: acceptingUntil?.toISOString() ?? null },
  });

  revalidatePath('/admin/cohorts');
  revalidatePath('/admin');
  return {
    ok: true,
    message: updated.acceptingUntil
      ? `Submissions are open again until ${formatInTimezone(updated.acceptingUntil, cohort.timezone, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })} ${timezoneLabel(updated.acceptingUntil, cohort.timezone)}.`
      : 'Submissions are open again.',
  };
}

// --------------------------------------------------------------------------
// Submissions
// --------------------------------------------------------------------------

export interface ReceiptLookupResult {
  found: boolean;
  message?: string;
  submissionId?: string;
  groupNumber?: number;
  productName?: string | null;
  submittedAtLabel?: string;
}

/**
 * Find a submission by receipt ID.
 *
 * Normalised generously — a learner will paste it with the wrong case, extra
 * spaces, or wrapped in quotes from a chat message, and none of that should
 * mean "not found".
 */
export async function lookupReceiptAction(formData: FormData): Promise<ReceiptLookupResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const receiptId = String(formData.get('receiptId') ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');

  if (!receiptId) {
    return { found: false, message: 'Enter the receipt ID from the team’s message.' };
  }

  const store = await getStoreAsync();
  const submission = await store.submissions.findByReceiptId(receiptId);
  if (!submission) {
    return {
      found: false,
      message: `No submission has receipt ID ${receiptId}. Check for a transcription slip — I and 1, O and 0.`,
    };
  }

  const [team, cohort] = await Promise.all([
    store.teams.getTeam(submission.teamId),
    store.cohorts.getCohort(submission.cohortId),
  ]);

  return {
    found: true,
    submissionId: submission.id,
    groupNumber: team?.groupNumber ?? 0,
    productName: submission.productName,
    submittedAtLabel:
      submission.submittedAt && cohort
        ? `${formatInTimezone(submission.submittedAt, cohort.timezone, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })} ${timezoneLabel(submission.submittedAt, cohort.timezone)}`
        : 'at an unrecorded time',
  };
}

export async function reopenSubmissionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'Give a reason — the team sees this, and so does the audit log.' };

  const store = await getStoreAsync();
  const submission = await store.submissions.reopenSubmission(submissionId, reason);
  await auditAdminAction({
    action: 'submission.reopened',
    entityType: 'submission',
    entityId: submissionId,
    cohortId: submission.cohortId,
    after: { reason },
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: 'Submission reopened. The team can edit it while the cohort is open.' };
}

export async function revealCredentialsAction(submissionId: string): Promise<{
  ok: boolean;
  username?: string;
  password?: string;
  loginInstructions?: string;
  error?: string;
}> {
  await requireAdmin();
  const store = await getStoreAsync();
  const submission = await store.submissions.getSubmission(submissionId);
  if (!submission) return { ok: false, error: 'Submission not found.' };

  const revealed = await store.submissions.revealCredentials(submissionId);
  if (!revealed) return { ok: false, error: 'No credentials are stored for this submission.' };

  // Revealing a third party's credential is privileged and always audited.
  await auditAdminAction({
    action: 'credentials.revealed',
    entityType: 'submission',
    entityId: submissionId,
    cohortId: submission.cohortId,
  });
  return { ok: true, ...revealed };
}

export async function setLateExceptionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const granted = formData.get('granted') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'A late exception needs a recorded reason.' };

  const store = await getStoreAsync();
  const submission = await store.submissions.setLateException(submissionId, granted, reason);
  await auditAdminAction({
    action: granted ? 'submission.late_exception_granted' : 'submission.late_exception_revoked',
    entityType: 'submission',
    entityId: submissionId,
    cohortId: submission.cohortId,
    after: { reason },
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: granted ? 'Late exception granted.' : 'Late exception revoked.' };
}

// --------------------------------------------------------------------------
// Assessment
// --------------------------------------------------------------------------

export async function startJudgingAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));

  const cohortId = String(formData.get('cohortId') ?? '');
  const store = await getStoreAsync();

  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };
  if (cohort.status !== 'closed' && cohort.status !== 'judging') {
    return { ok: false, error: 'Close the cohort before starting judging.' };
  }

  const result = await store.assessment.enqueueCohort(cohortId);
  if (cohort.status === 'closed') await store.cohorts.setCohortStatus(cohortId, 'judging');

  await auditAdminAction({
    action: 'judging.started',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: result,
  });
  revalidatePath('/admin/assessment-queue');
  return {
    ok: true,
    message: `Queued ${result.queued} submission${result.queued === 1 ? '' : 's'} (${result.skipped} already queued or not finally submitted).`,
  };
}

export async function rerunAssessmentAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const store = await getStoreAsync();

  const job = await store.assessment.enqueueSubmission(submissionId);
  await auditAdminAction({
    action: 'assessment.rerun',
    entityType: 'submission',
    entityId: submissionId,
    cohortId: job.cohortId,
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: 'Re-queued. It will be picked up on the next worker poll.' };
}

export async function overrideScoreAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();

  const submissionId = String(formData.get('submissionId') ?? '');
  const jobId = String(formData.get('jobId') ?? '');
  const categoryKey = String(formData.get('categoryKey') ?? '');
  const rawScore = Number(formData.get('rawScore'));
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'An override requires a reason. It is recorded permanently.' };
  if (!Number.isFinite(rawScore) || rawScore < 0) return { ok: false, error: 'Enter a valid score.' };

  try {
    const score = await store.assessment.overrideScore({ jobId, categoryKey, rawScore, reason, actor: ACTOR });
    await auditAdminAction({
      action: 'score.overridden',
      entityType: 'submission',
      entityId: submissionId,
      before: { rawScore: score.originalRawScore },
      after: { rawScore, categoryKey, reason },
    });
    revalidatePath(`/admin/submissions/${submissionId}`);
    return { ok: true, message: `${categoryKey} overridden. Regenerate the ranking to apply it.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not override the score.' };
  }
}

export async function resolveManualReviewAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const flagId = String(formData.get('flagId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');
  const status = String(formData.get('status') ?? 'resolved') as 'resolved' | 'dismissed';
  const note = String(formData.get('note') ?? '').trim();

  if (!note) return { ok: false, error: 'Record what you concluded.' };

  await (await getStoreAsync()).assessment.resolveManualReview(flagId, { status, note, actor: ACTOR });
  await auditAdminAction({
    action: `manual_review.${status}`,
    entityType: 'submission',
    entityId: submissionId,
    after: { note },
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: `Flag ${status}.` };
}

// --------------------------------------------------------------------------
// Disqualification
// --------------------------------------------------------------------------

export async function confirmDisqualificationAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const id = String(formData.get('disqualificationId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');

  const record = await (await getStoreAsync()).assessment.confirmDisqualification(id, ACTOR);
  await auditAdminAction({
    action: 'disqualification.confirmed',
    entityType: 'submission',
    entityId: submissionId,
    after: { reasonCode: record.reasonCode },
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: 'Disqualification confirmed. It is reversible and fully logged.' };
}

export async function reverseDisqualificationAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const id = String(formData.get('disqualificationId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'Reversing a disqualification requires a reason.' };

  await (await getStoreAsync()).assessment.reverseDisqualification(id, ACTOR, reason);
  await auditAdminAction({
    action: 'disqualification.reversed',
    entityType: 'submission',
    entityId: submissionId,
    after: { reason },
  });
  revalidatePath(`/admin/submissions/${submissionId}`);
  return { ok: true, message: 'Disqualification reversed. Regenerate the ranking to include the team again.' };
}

export async function proposeDisqualificationAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const reasonCode = String(formData.get('reasonCode') ?? '');
  const reasonDetail = String(formData.get('reasonDetail') ?? '').trim();

  if (!reasonDetail) return { ok: false, error: 'Record the evidence for this decision.' };

  try {
    // Throws if the ground is not one of the eleven permitted (ADR-017).
    assertDisqualificationAllowed(reasonCode, { proposedBySystem: false });
    await (await getStoreAsync()).assessment.proposeDisqualification({
      submissionId,
      reasonCode,
      reasonDetail,
      evidence: { raisedBy: 'shared-admin' },
      status: 'proposed',
      proposedBy: 'shared-admin',
      confirmedBy: null,
      reversedBy: null,
      reversedReason: null,
    });
    await auditAdminAction({
      action: 'disqualification.proposed',
      entityType: 'submission',
      entityId: submissionId,
      after: { reasonCode },
    });
    revalidatePath(`/admin/submissions/${submissionId}`);
    return { ok: true, message: 'Disqualification proposed. Confirm it separately.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Not a permitted ground.' };
  }
}

// --------------------------------------------------------------------------
// Ranking and final selection
// --------------------------------------------------------------------------

export async function generateRankingAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || undefined;

  const snapshot = await (await getStoreAsync()).ranking.generateSnapshot(cohortId, notes);
  await auditAdminAction({
    action: 'ranking.snapshot_generated',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: { snapshotId: snapshot.id, eligibleCount: snapshot.eligibleCount },
  });
  revalidatePath('/admin/ranking');
  return {
    ok: true,
    message: `New ranking snapshot with ${snapshot.eligibleCount} eligible submission${snapshot.eligibleCount === 1 ? '' : 's'}. The previous snapshot is preserved.`,
  };
}

/**
 * Set the final four.
 *
 * This is the only path in the codebase that writes a final selection, and it
 * requires an authenticated admin (ADR-018). No worker, stage, or AI response
 * can reach it.
 */
export async function setFinalSelectionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const cohortId = String(formData.get('cohortId') ?? '');

  const selections = [1, 2, 3, 4]
    .map((position) => ({
      position,
      submissionId: String(formData.get(`position-${position}`) ?? ''),
      reason: String(formData.get(`reason-${position}`) ?? '').trim(),
    }))
    .filter((s) => s.submissionId);

  if (selections.length !== 4) {
    return { ok: false, error: 'Choose a submission for all four positions.' };
  }
  if (selections.some((s) => !s.reason)) {
    return { ok: false, error: 'Give a reason for each winner. This is what makes the decision defensible.' };
  }

  const snapshot = await store.ranking.getCurrentSnapshot(cohortId);
  const eligible = new Set(snapshot?.entries.map((e) => e.submissionId) ?? []);
  const validation = validateFinalSelection(selections, eligible);
  if (!validation.valid) return { ok: false, error: validation.problems.join(' ') };

  await store.ranking.setFinalSelection(cohortId, selections, ACTOR);
  await auditAdminAction({
    action: 'final_selection.set',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: { positions: selections.map((s) => ({ position: s.position, submissionId: s.submissionId })) },
  });
  revalidatePath('/admin/final-selection');
  return { ok: true, message: 'Final four recorded. Nothing is announced automatically.' };
}

export async function clearFinalSelectionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');

  await (await getStoreAsync()).ranking.clearFinalSelection(cohortId, ACTOR);
  await auditAdminAction({
    action: 'final_selection.cleared',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
  });
  revalidatePath('/admin/final-selection');
  return { ok: true, message: 'Final selection cleared.' };
}

/**
 * Select which submissions get a second scoring pass.
 *
 * Running a second pass on everyone roughly doubles AI cost for little benefit;
 * running it on nobody leaves the decisions that actually matter — the ones
 * near the cutoff — resting on a single pass. This picks exactly the cases
 * where a disagreement would change an outcome, and re-queues them.
 */
export async function runConsistencyPassAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  const unavailable = await requireJudging();
  if (unavailable) return unavailable;
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const cohortId = String(formData.get('cohortId') ?? '');

  const cohort = await store.cohorts.getCohort(cohortId);
  const snapshot = await store.ranking.getCurrentSnapshot(cohortId);
  if (!cohort || !snapshot) {
    return { ok: false, error: 'Generate a ranking snapshot before running a consistency pass.' };
  }

  const flags = await store.assessment.listManualReviewFlags(cohortId);
  const disqualifications = await store.assessment.listDisqualifications(cohortId);

  // The stored vector is a loose jsonb map; rebuild the typed shape the
  // selector expects rather than widening its contract.
  const rankedEntries = snapshot.entries.map((e) => ({
    submissionId: e.submissionId,
    rank: e.entry.rank,
    totalScore: e.entry.totalScore,
    meanConfidence: e.entry.meanConfidence,
    inShortlist: e.entry.inShortlist,
    tiebreakVector: {
      total: e.entry.tiebreakVector.total ?? e.entry.totalScore,
      core_workflow: e.entry.tiebreakVector.core_workflow ?? 0,
      solution_usefulness: e.entry.tiebreakVector.solution_usefulness ?? 0,
      ai_usefulness: e.entry.tiebreakVector.ai_usefulness ?? 0,
      two_day_execution: e.entry.tiebreakVector.two_day_execution ?? 0,
      unresolvedRisks: e.entry.tiebreakVector.unresolvedRisks ?? 0,
    },
  }));

  const candidates = selectForConsistencyReview(rankedEntries, {
    shortlistTarget: cohort.shortlistTarget,
    lowConfidenceIds: new Set(snapshot.entries.filter((e) => e.lowConfidence).map((e) => e.submissionId)),
    manualReviewIds: new Set(flags.filter((f) => f.status === 'open').map((f) => f.submissionId)),
    disputedIds: new Set(
      disqualifications.filter((d) => d.status === 'proposed').map((d) => d.submissionId),
    ),
  });

  for (const candidate of candidates) {
    const job = await store.assessment.getJobBySubmission(candidate.submissionId);
    if (!job) continue;
    await store.assessment.advanceStage(job.id, 'consistency_review');
  }

  await auditAdminAction({
    action: 'consistency_pass.queued',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: {
      count: candidates.length,
      triggers: candidates.map((c) => ({ submissionId: c.submissionId, triggers: c.triggers })),
    },
  });
  revalidatePath('/admin/ranking');

  return {
    ok: true,
    message:
      candidates.length === 0
        ? 'No submissions met a second-pass trigger.'
        : `Queued ${candidates.length} submission${candidates.length === 1 ? '' : 's'} for a second scoring pass (top 20, low confidence, manual review, near the cutoff, close ties, or disputed).`,
  };
}

/** Private shortlist export, for internal use only. */
export async function exportShortlistAction(cohortId: string): Promise<string> {
  await requireAdmin();
  const store = await getStoreAsync();
  const snapshot = await store.ranking.getCurrentSnapshot(cohortId);
  if (!snapshot) return 'No ranking snapshot exists yet.\r\n';

  await auditAdminAction({
    action: 'shortlist.exported',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    after: { entries: snapshot.entries.length },
  });

  return toCsv(
    ['Rank', 'Group', 'Product', 'Idea', 'Total score', 'Mean confidence', 'In shortlist', 'Low confidence', 'Open manual review'],
    snapshot.entries.map((entry) => [
      entry.entry.rank,
      entry.groupNumber,
      entry.productName ?? '',
      entry.ideaTitle ?? '',
      entry.entry.totalScore,
      entry.entry.meanConfidence,
      entry.entry.inShortlist ? 'yes' : 'no',
      entry.lowConfidence ? 'yes' : 'no',
      entry.hasOpenManualReview ? 'yes' : 'no',
    ]),
  );
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

/**
 * Judging configuration, entered in the units an operator thinks in.
 *
 * Minutes are converted to milliseconds here, so a programme operator never has
 * to type 480000 and the stored value stays in the unit the worker expects.
 */
export async function updateJudgingSettingsAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = await getStoreAsync();
  const cohortId = String(formData.get('cohortId') ?? '');

  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'Cohort not found.' };

  const number = (key: string, fallback: number) => {
    const raw = Number(formData.get(key));
    return Number.isFinite(raw) ? raw : fallback;
  };

  const concurrency = Math.round(number('workerConcurrency', cohort.assessmentConfig.workerConcurrency));
  const browserMinutes = number('browserMinutes', cohort.assessmentConfig.browserBudgetMs / 60_000);
  const maxAttempts = Math.round(number('maxAttempts', cohort.assessmentConfig.maxAttempts));
  const threshold = number('lowConfidenceThreshold', cohort.assessmentConfig.lowConfidenceThreshold);
  const shortlistTarget = Math.round(number('shortlistTarget', cohort.shortlistTarget));

  if (concurrency < 1 || concurrency > 32) {
    return { ok: false, error: 'Concurrent assessments must be between 1 and 32.' };
  }
  if (browserMinutes < 1 || browserMinutes > 30) {
    return { ok: false, error: 'Maximum browser-testing time must be between 1 and 30 minutes.' };
  }
  if (maxAttempts < 1 || maxAttempts > 10) {
    return { ok: false, error: 'Maximum retries must be between 1 and 10.' };
  }
  if (threshold < 0 || threshold > 1) {
    return { ok: false, error: 'The low-confidence threshold must be between 0 and 1.' };
  }
  if (shortlistTarget < 1 || shortlistTarget > 100) {
    return { ok: false, error: 'The shortlist size must be between 1 and 100.' };
  }

  const before = { ...cohort.assessmentConfig, shortlistTarget: cohort.shortlistTarget };

  await store.cohorts.updateCohort(cohortId, {
    shortlistTarget,
    assessmentConfig: {
      ...cohort.assessmentConfig,
      workerConcurrency: concurrency,
      // Friendly minutes in, canonical milliseconds stored.
      browserBudgetMs: Math.round(browserMinutes * 60_000),
      maxAttempts,
      lowConfidenceThreshold: threshold,
    },
  });

  await auditAdminAction({
    action: 'judging_settings.updated',
    entityType: 'cohort',
    entityId: cohortId,
    cohortId,
    before,
    after: { concurrency, browserMinutes, maxAttempts, threshold, shortlistTarget },
  });
  revalidatePath('/admin/settings');
  revalidatePath('/admin/assessment-queue');

  return {
    ok: true,
    message: `Saved. Browser testing is limited to ${browserMinutes} minute${browserMinutes === 1 ? '' : 's'} per submission, ${concurrency} at a time.`,
  };
}

export async function updateSettingAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const key = String(formData.get('key') ?? '');
  const rawValue = String(formData.get('value') ?? '');

  let value: unknown = rawValue;
  const asNumber = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isFinite(asNumber)) value = asNumber;
  else if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true';

  await (await getStoreAsync()).settings.set(key, value, ACTOR);
  await auditAdminAction({
    action: 'setting.updated',
    entityType: 'system_setting',
    entityId: key,
    after: { key, value },
  });
  revalidatePath('/admin/settings');
  return { ok: true, message: `${key} updated.` };
}
