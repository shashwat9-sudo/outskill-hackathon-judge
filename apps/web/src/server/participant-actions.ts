'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  CREDENTIAL_FIELDS,
  evaluateCompleteness,
  finalSubmitSchema,
  hashIdentifier,
  looksLikePdf,
  validateDeckUpload,
  validateDemoVideoUrl,
  type ParticipantView,
} from '@ohj/shared';
import { getEnvConfig, getStore } from '@/lib/store';

/**
 * Participant server actions.
 *
 * Every action re-resolves the invite token server-side and derives the
 * submission id from it. The client never supplies a submission id that is
 * trusted — that is what makes it impossible for one team to write to another
 * team's submission by tampering with a request (threat model T1).
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  receiptId?: string;
}

async function resolveOwnSubmission(token: string) {
  const store = getStore();
  const view = await store.participant.resolveInvite(token);
  if (!view) return null;
  return { store, view };
}

async function ipHash(): Promise<string | null> {
  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) return null;
  return hashIdentifier(ip, getEnvConfig().ADMIN_SESSION_SECRET ?? 'demo-salt');
}

/**
 * Autosave.
 *
 * Credentials are split out of the draft before it is stored: the draft blob is
 * plain JSON, so a credential left inside it would sit unencrypted at rest.
 */
export async function saveDraftAction(token: string, draft: unknown): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission(token);
  if (!resolved) return { ok: false, error: 'This link is no longer valid.' };
  const { store, view } = resolved;

  if (!view.canEdit) {
    return {
      ok: false,
      error:
        view.submission.status === 'locked'
          ? 'Your submission is locked. Contact the Outskill team if you need it reopened.'
          : 'This cohort is not currently accepting changes.',
    };
  }

  try {
    const payload = (draft ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const live: Record<string, unknown> = { ...(payload.live ?? {}) };

    const credentials = {
      username: typeof live.demoUsername === 'string' ? live.demoUsername : undefined,
      password: typeof live.demoPassword === 'string' ? live.demoPassword : undefined,
      loginInstructions: typeof live.loginInstructions === 'string' ? live.loginInstructions : undefined,
    };
    for (const field of CREDENTIAL_FIELDS) delete live[field];

    await store.participant.saveDraft(view.submission.id, { ...payload, live });

    if (credentials.username || credentials.password || credentials.loginInstructions) {
      await store.participant.storeCredentials(view.submission.id, credentials);
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save your draft.' };
  }
}

/**
 * Final submit.
 *
 * Validated against the strict schemas on the server. A client that skipped
 * validation, or a request replayed after the cohort closed, is rejected here.
 */
export async function finalSubmitAction(token: string, confirmation: string): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission(token);
  if (!resolved) return { ok: false, error: 'This link is no longer valid.' };
  const { store, view } = resolved;

  const confirmed = finalSubmitSchema.safeParse({ confirmation });
  if (!confirmed.success) {
    return { ok: false, error: confirmed.error.issues[0]?.message ?? 'Confirmation text does not match.' };
  }

  if (!view.canEdit) {
    return { ok: false, error: 'This submission can no longer be changed.' };
  }

  const completeness = evaluateCompleteness(buildValidationPayload(view));
  if (!completeness.complete) {
    const incomplete = completeness.steps.filter((s) => !s.complete).map((s) => s.label);
    return {
      ok: false,
      error: `Some steps are still incomplete: ${incomplete.join(', ')}. Fix them on the review screen, then submit.`,
    };
  }

  try {
    const { receiptId } = await store.participant.finaliseSubmission(view.submission.id, {
      ipHash: await ipHash(),
    });
    revalidatePath(`/submit/${token}`);
    return { ok: true, receiptId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not submit.' };
  }
}

/**
 * Deck upload.
 *
 * MIME type, extension, size AND magic bytes are all checked — a client-
 * supplied content type is a claim, not evidence (threat model T9). In demo
 * mode the bytes are not persisted; only the metadata record is created.
 */
export async function uploadDeckAction(token: string, formData: FormData): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission(token);
  if (!resolved) return { ok: false, error: 'This link is no longer valid.' };
  const { store, view } = resolved;

  if (!view.canEdit) return { ok: false, error: 'This submission can no longer be changed.' };

  const file = formData.get('deck');
  if (!(file instanceof File)) return { ok: false, error: 'No file was received.' };

  const basic = validateDeckUpload({ name: file.name, type: file.type, size: file.size });
  if (!basic.ok) return { ok: false, error: basic.message };

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!looksLikePdf(head)) {
    return { ok: false, error: 'That file is not a PDF. Export your deck as a PDF and upload it again.' };
  }

  try {
    await store.participant.attachArtifact(view.submission.id, {
      kind: 'deck_pdf',
      storageBucket: 'submission-decks',
      storagePath: `${view.cohort.id}/${view.submission.id}/pitch-deck.pdf`,
      originalFilename: file.name,
      mimeType: file.type,
      byteSize: file.size,
      checksumSha256: null,
      externalUrl: null,
      uploadCompletedAt: new Date(),
      isAccessible: true,
      lastCheckedAt: new Date(),
    });
    revalidatePath(`/submit/${token}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not store the upload.' };
  }
}

export async function setDemoVideoAction(token: string, url: string): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission(token);
  if (!resolved) return { ok: false, error: 'This link is no longer valid.' };
  const { store, view } = resolved;
  if (!view.canEdit) return { ok: false, error: 'This submission can no longer be changed.' };

  const validation = validateDemoVideoUrl(url);
  if (!validation.ok) return { ok: false, error: validation.message };

  try {
    await store.participant.attachArtifact(view.submission.id, {
      kind: 'demo_video',
      storageBucket: null,
      storagePath: null,
      originalFilename: null,
      mimeType: null,
      byteSize: null,
      checksumSha256: null,
      externalUrl: validation.normalised ?? url,
      uploadCompletedAt: new Date(),
      isAccessible: null,
      lastCheckedAt: null,
    });
    revalidatePath(`/submit/${token}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the link.' };
  }
}

/** Server-side completeness, for the review screen. */
export async function getCompletenessAction(token: string) {
  const resolved = await resolveOwnSubmission(token);
  if (!resolved) return null;
  return evaluateCompleteness(buildValidationPayload(resolved.view));
}

/**
 * Assemble the payload the strict schemas validate against.
 *
 * Merges the promoted columns with the raw draft so a team is judged complete
 * on what is actually stored, not on whatever the client last held in memory.
 */
function buildValidationPayload(view: ParticipantView): Record<string, unknown> {
  const submission = view.submission;
  const draft = submission.draftPayload as Record<string, Record<string, unknown> | undefined>;
  const deck = view.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = view.artifacts.find((a) => a.kind === 'demo_video');
  const draftTeam = draft.team ?? {};

  return {
    team: {
      groupNumber: view.team.groupNumber,
      leadName: view.team.leadName,
      leadEmail: view.team.leadEmail,
      leadPhone: view.team.leadPhone,
      members: view.members.map((m) => ({
        fullName: m.fullName,
        contribution: m.contribution,
        isActive: m.isActive,
      })),
      ...draftTeam,
    },
    product: {
      ideaId: submission.ideaId,
      productName: submission.productName,
      primaryUser: submission.primaryUser,
      exactProblem: submission.exactProblem,
      oneSentencePromise: submission.oneSentencePromise,
      briefDescription: submission.briefDescription,
      whyAiNecessary: submission.whyAiNecessary,
      differentiation: submission.differentiation,
      mustHaveWorkflow: submission.mustHaveWorkflow,
      shouldHaveFeatures: submission.shouldHaveFeatures,
      excludedFeatures: submission.excludedFeatures,
    },
    live: {
      productUrl: submission.productUrl,
      loginRequired: submission.loginRequired,
      coreTestSteps: submission.coreTestSteps,
      safeSampleInputs: submission.safeSampleInputs,
      resetInstructions: submission.resetInstructions,
      knownLimitations: submission.knownLimitations,
      // Presence, never values — enough to satisfy the conditional requirement.
      demoUsername: view.hasStoredCredentials ? 'stored' : undefined,
      demoPassword: view.hasStoredCredentials ? 'stored' : undefined,
    },
    artifacts: {
      deckArtifactId: deck?.id,
      demoVideoUrl: video?.externalUrl,
      demoUnderThreeMinutes: (draft.artifacts?.demoUnderThreeMinutes as boolean) ?? false,
      screenshotArtifactIds: [],
    },
    learning: {
      bugsFixed: submission.bugsFixed,
      deliberatelyExcluded: submission.deliberatelyExcluded,
      majorTradeoff: submission.majorTradeoff,
      day12ToDay13Changes: submission.day12ToDay13Changes,
      mostImportantLearning: submission.mostImportantLearning,
      nextSevenDayPlan: submission.nextSevenDayPlan,
      builderStack: submission.builderStack,
      apisUsed: submission.apisUsed ?? '',
      externalTemplates: submission.externalTemplates ?? '',
    },
    declarations: view.declarations
      ? {
          builtDuringHackathon: view.declarations.builtDuringHackathon,
          ownedByTeam: view.declarations.ownedByTeam,
          externalMaterialDisclosed: view.declarations.externalMaterialDisclosed,
          judgeMayModifyDemoData: view.declarations.judgeMayModifyDemoData,
          noRealCustomerData: view.declarations.noRealCustomerData,
          urlsAvailableThroughJudging: view.declarations.urlsAvailableThroughJudging,
          permissionToSubmit: view.declarations.permissionToSubmit,
        }
      : (draft.declarations ?? {}),
  };
}
