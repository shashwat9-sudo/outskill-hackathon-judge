'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  assertDisqualificationAllowed,
  buildInviteCsv,
  parseTeamImportCsv,
  selectForConsistencyReview,
  toCsv,
  validateFinalSelection,
  type CohortStatus,
} from '@ohj/shared';
import { getEnvConfig, getStore } from '@/lib/store';
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
  const store = getStore();
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
      submissionInstructions: String(formData.get('submissionInstructions') ?? ''),
      rubricVersion: 'rubric-v1',
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

export async function setCohortStatusAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = getStore();

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
  const store = getStore();

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
      const idea = await store.cohorts.createIdea({ ...patch, cohortId });
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

export async function deactivateIdeaAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const ideaId = String(formData.get('ideaId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  // Soft-delete: a past submission must keep resolving its idea.
  await getStore().cohorts.deleteIdea(ideaId);
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
  const store = getStore();
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

export async function regenerateInviteAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const teamId = String(formData.get('teamId') ?? '');
  const cohortId = String(formData.get('cohortId') ?? '');

  await getStore().teams.generateInvite(teamId);
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

  await getStore().teams.revokeInvite(teamId);
  await auditAdminAction({ action: 'invite.revoked', entityType: 'team', entityId: teamId, cohortId });
  revalidatePath(`/admin/cohorts/${cohortId}/teams`);
  return { ok: true, message: 'Invite revoked.' };
}

/** Build the invite CSV for distribution through Outskill's own channel (ADR-024). */
export async function exportInvitesAction(cohortId: string): Promise<string> {
  await requireAdmin();
  const store = getStore();
  const env = getEnvConfig();
  const teams = await store.teams.listTeams(cohortId);

  const { MemoryDataStore } = await import('@ohj/shared');
  const memory = store instanceof MemoryDataStore ? store : null;

  const rows = teams
    .map((team) => {
      const token = memory?.getDemoInviteToken(team.id);
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
// Submissions
// --------------------------------------------------------------------------

export async function reopenSubmissionAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'Give a reason — the team sees this, and so does the audit log.' };

  const store = getStore();
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
  const store = getStore();
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

  const store = getStore();
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');
  const store = getStore();

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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const store = getStore();

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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = getStore();

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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const flagId = String(formData.get('flagId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');
  const status = String(formData.get('status') ?? 'resolved') as 'resolved' | 'dismissed';
  const note = String(formData.get('note') ?? '').trim();

  if (!note) return { ok: false, error: 'Record what you concluded.' };

  await getStore().assessment.resolveManualReview(flagId, { status, note, actor: ACTOR });
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const id = String(formData.get('disqualificationId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');

  const record = await getStore().assessment.confirmDisqualification(id, ACTOR);
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const id = String(formData.get('disqualificationId') ?? '');
  const submissionId = String(formData.get('submissionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) return { ok: false, error: 'Reversing a disqualification requires a reason.' };

  await getStore().assessment.reverseDisqualification(id, ACTOR, reason);
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const submissionId = String(formData.get('submissionId') ?? '');
  const reasonCode = String(formData.get('reasonCode') ?? '');
  const reasonDetail = String(formData.get('reasonDetail') ?? '').trim();

  if (!reasonDetail) return { ok: false, error: 'Record the evidence for this decision.' };

  try {
    // Throws if the ground is not one of the eleven permitted (ADR-017).
    assertDisqualificationAllowed(reasonCode, { proposedBySystem: false });
    await getStore().assessment.proposeDisqualification({
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || undefined;

  const snapshot = await getStore().ranking.generateSnapshot(cohortId, notes);
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = getStore();
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const cohortId = String(formData.get('cohortId') ?? '');

  await getStore().ranking.clearFinalSelection(cohortId, ACTOR);
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
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const store = getStore();
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
      stability: e.entry.tiebreakVector.stability ?? 0,
      ai_usefulness: e.entry.tiebreakVector.ai_usefulness ?? 0,
      learning_execution: e.entry.tiebreakVector.learning_execution ?? 0,
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
  const store = getStore();
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

export async function updateSettingAction(formData: FormData): Promise<AdminActionResult> {
  await requireAdmin();
  await assertCsrf(String(formData.get('csrf') ?? ''));
  const key = String(formData.get('key') ?? '');
  const rawValue = String(formData.get('value') ?? '');

  let value: unknown = rawValue;
  const asNumber = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isFinite(asNumber)) value = asNumber;
  else if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true';

  await getStore().settings.set(key, value, ACTOR);
  await auditAdminAction({
    action: 'setting.updated',
    entityType: 'system_setting',
    entityId: key,
    after: { key, value },
  });
  revalidatePath('/admin/settings');
  return { ok: true, message: `${key} updated.` };
}
