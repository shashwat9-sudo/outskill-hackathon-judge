'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CREDENTIAL_FIELDS,
  GENERIC_VERIFICATION_ERROR,
  PARTICIPANT_PENDING_COOKIE,
  PARTICIPANT_SESSION_COOKIE,
  evaluateCompleteness,
  finalSubmitSchema,
  hashIdentifier,
  isWellFormedAccessCode,
  looksLikePdf,
  participantCookieOptions,
  pendingCookieOptions,
  readVerificationHandle,
  signVerificationHandle,
  validateDeckUpload,
  validateDemoVideoUrl,
  validateEditorIdentity,
  type ParticipantView,
  type TeamActivityKind,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';

/**
 * Participant server actions.
 *
 * Every action resolves the SESSION COOKIE server-side and derives the team and
 * submission from it. The client never supplies a submission id, a team id or an
 * access code that is trusted — that is what makes it impossible for one team to
 * write to another team's submission by tampering with a request (threat model
 * T1), and it is why the access code never has to travel after verification.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  receiptId?: string;
  /** Set when a teammate saved first. The client reloads and shows the message. */
  conflict?: { currentVersion: number; message: string };
  /** The version the row holds after a successful write. */
  version?: number;
}

const SESSION_EXPIRED = 'Your session has ended. Enter your group number and access code again.';
const VERIFICATION_EXPIRED =
  'That took a little too long. Enter your group number and access code again.';

async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(PARTICIPANT_SESSION_COOKIE)?.value ?? null;
}

/**
 * Resolve the caller's own submission.
 *
 * Returns null for a missing, expired, revoked or rotated session — the caller
 * turns that into one message, never into a reason.
 */
async function resolveOwnSubmission() {
  const token = await sessionToken();
  if (!token) return null;
  const store = await getStoreAsync();
  const view = await store.participant.resolveSession(token);
  if (!view) return null;
  return { store, view, token };
}

async function ipHash(): Promise<string> {
  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return hashIdentifier(ip, getEnvConfig().ADMIN_SESSION_SECRET ?? 'demo-salt');
}

// --------------------------------------------------------------------------
// Entry: verify, then identify
// --------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  error?: string;
  retryAfterSeconds?: number;
}

/**
 * Step 1: group number + access code.
 *
 * Every failure returns the same message. An unknown group, a wrong code, a
 * revoked code and a withdrawn team are indistinguishable from outside, so the
 * form cannot be used to enumerate which groups exist.
 */
export async function verifyTeamAction(formData: FormData): Promise<VerifyResult> {
  const rawGroup = String(formData.get('groupNumber') ?? '').trim();
  const rawCode = String(formData.get('accessCode') ?? '');
  const groupNumber = Number.parseInt(rawGroup, 10);

  // Shape checks are local and reveal nothing about the cohort.
  if (!Number.isInteger(groupNumber) || groupNumber < 1 || groupNumber > 999) {
    return { ok: false, error: GENERIC_VERIFICATION_ERROR };
  }
  if (!isWellFormedAccessCode(rawCode)) {
    return { ok: false, error: GENERIC_VERIFICATION_ERROR };
  }

  const result = await (await getStoreAsync()).participant.verifyTeamAccess({
    groupNumber,
    code: rawCode,
    ipHash: await ipHash(),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.message,
      retryAfterSeconds: result.reason === 'rate_limited' ? result.retryAfterSeconds : undefined,
    };
  }

  // The verified team is carried to the editor-name step in an HttpOnly cookie
  // holding a signed, ten-minute assertion. It never reaches the DOM, and it
  // cannot be forged into a session for a team whose code the caller never had.
  const jar = await cookies();
  jar.set(
    PARTICIPANT_PENDING_COOKIE,
    signVerificationHandle(result.teamId, handleSecret()),
    pendingCookieOptions(process.env.NODE_ENV === 'production'),
  );

  return { ok: true };
}

/**
 * The signing key for verification handles.
 *
 * Falls back only in demo mode, where there is no secret to configure and no
 * real team to protect. In production `ADMIN_SESSION_SECRET` is required at
 * startup, so the fallback is unreachable.
 */
function handleSecret(): string {
  return getEnvConfig().ADMIN_SESSION_SECRET ?? 'demo-handle-secret';
}

/**
 * Step 2: who is editing.
 *
 * The name is an ACTIVITY LABEL, not verified identity — anyone with the shared
 * code can type anything. It exists so a team can see who changed what. Nothing
 * security-relevant depends on it.
 */
export async function startEditingAction(formData: FormData): Promise<ActionResult> {
  const jar = await cookies();
  const handle = readVerificationHandle(
    jar.get(PARTICIPANT_PENDING_COOKIE)?.value ?? '',
    handleSecret(),
  );

  const identity = validateEditorIdentity(
    String(formData.get('editorName') ?? ''),
    String(formData.get('editorRole') ?? ''),
  );

  // Validate the name first so a slow typist is told about the name, not sent
  // back to the code screen for a handle that is still perfectly good.
  if (!identity.valid || !identity.value) {
    return { ok: false, error: identity.problems[0] };
  }
  if (!handle.valid || !handle.teamId) {
    return { ok: false, error: VERIFICATION_EXPIRED };
  }

  const store = await getStoreAsync();
  let session;
  try {
    session = await store.participant.createSession({
      teamId: handle.teamId,
      editorName: identity.value.name,
      editorRole: identity.value.role,
      ipHash: await ipHash(),
    });
  } catch {
    // A team that no longer resolves gets the same message as an expired handle.
    return { ok: false, error: VERIFICATION_EXPIRED };
  }

  jar.set(
    PARTICIPANT_SESSION_COOKIE,
    session.token,
    participantCookieOptions(session.expiresAt, process.env.NODE_ENV === 'production'),
  );
  jar.delete(PARTICIPANT_PENDING_COOKIE);

  await store.participant.recordActivity(session.token, 'draft_opened');
  return { ok: true };
}

/**
 * The invite path's version of step 2.
 *
 * Same name validation, same cookie, same activity record — it differs only in
 * where the verified team comes from. Kept as a separate action rather than an
 * optional `token` parameter on the common one, so nothing in the production
 * flow can be persuaded to accept a token from a form field.
 */
export async function startEditingWithInviteAction(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get('token') ?? '');
  const identity = validateEditorIdentity(
    String(formData.get('editorName') ?? ''),
    String(formData.get('editorRole') ?? ''),
  );

  if (!identity.valid || !identity.value) {
    return { ok: false, error: identity.problems[0] };
  }

  const store = await getStoreAsync();
  const session = await store.participant.redeemInviteToken(token, identity.value);
  // Unknown, revoked and expired invites are indistinguishable from here.
  if (!session) {
    return { ok: false, error: 'This link is no longer valid. Ask the Outskill team for a new one.' };
  }

  const jar = await cookies();
  jar.set(
    PARTICIPANT_SESSION_COOKIE,
    session.token,
    participantCookieOptions(session.expiresAt, process.env.NODE_ENV === 'production'),
  );

  await store.participant.recordActivity(session.token, 'draft_opened');
  return { ok: true };
}

/** Sign this browser out. Other members keep their own sessions. */
export async function endSessionAction(): Promise<void> {
  const token = await sessionToken();
  if (token) await (await getStoreAsync()).participant.endSession(token);
  (await cookies()).delete(PARTICIPANT_SESSION_COOKIE);
  redirect('/submit');
}

// --------------------------------------------------------------------------
// Editing
// --------------------------------------------------------------------------

/**
 * Autosave.
 *
 * Credentials are split out of the draft before it is stored: the draft blob is
 * plain JSON, so a credential left inside it would sit unencrypted at rest.
 *
 * `expectedVersion` is the version the client last read. A write that is behind
 * is refused rather than allowed to overwrite a teammate silently.
 */
export async function saveDraftAction(draft: unknown, expectedVersion: number): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;

  if (!view.canEdit) return { ok: false, error: view.windowMessage };

  const payload = (draft ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const live: Record<string, unknown> = { ...(payload.live ?? {}) };

  const credentials = {
    username: typeof live.demoUsername === 'string' ? live.demoUsername : undefined,
    password: typeof live.demoPassword === 'string' ? live.demoPassword : undefined,
    loginInstructions: typeof live.loginInstructions === 'string' ? live.loginInstructions : undefined,
  };
  for (const field of CREDENTIAL_FIELDS) delete live[field];

  const result = await store.participant.saveDraft(token, { ...payload, live }, expectedVersion);
  if (!result.ok) {
    return { ok: false, error: result.error ?? result.conflict?.message, conflict: result.conflict };
  }

  if (credentials.username || credentials.password || credentials.loginInstructions) {
    await store.participant.storeCredentials(token, credentials);
  }

  // The version the row now holds, so the client tracks the database rather
  // than counting its own successes. A client that increments locally drifts
  // the moment anything else writes, and then every save it makes is refused
  // while the screen still says the work is fine.
  return { ok: true, version: result.submission?.version };
}

/**
 * Final submit.
 *
 * Validated against the strict schemas on the server. A client that skipped
 * validation, or a request replayed after the cohort closed, is rejected here.
 */
export async function finalSubmitAction(confirmation: string): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;

  const confirmed = finalSubmitSchema.safeParse({ confirmation });
  if (!confirmed.success) {
    return { ok: false, error: confirmed.error.issues[0]?.message ?? 'Confirmation text does not match.' };
  }

  if (!view.canSubmit) return { ok: false, error: view.windowMessage };

  const completeness = evaluateCompleteness(buildValidationPayload(view));
  if (!completeness.complete) {
    const incomplete = completeness.steps.filter((s) => !s.complete).map((s) => s.label);
    return {
      ok: false,
      error: `Some steps are still incomplete: ${incomplete.join(', ')}. Fix them on the review screen, then submit.`,
    };
  }

  const result = await store.participant.finaliseSubmission(token, { ipHash: await ipHash() });
  if (!result.ok) {
    return { ok: false, error: result.error ?? result.conflict?.message, conflict: result.conflict };
  }

  revalidatePath('/submit/portal');
  return { ok: true, receiptId: result.receiptId };
}

/**
 * Step one of a deck upload: permission to write one object.
 *
 * The bytes never come through here. A serverless request body tops out around
 * 4.5 MB and the deck limit is 25, so a file large enough to matter cannot
 * reach a function at all — the old path could only ever have worked for small
 * decks, and failed with a platform error rather than one of our sentences.
 *
 * What the browser gets back is a URL that can write to exactly one path this
 * server chose, and nothing else: no bucket name it can change, no key it can
 * reuse, no second object it can reach.
 */
export async function createDeckUploadTicketAction(input: {
  filename: string;
  byteSize: number;
  mimeType: string;
}): Promise<{ ok: boolean; uploadUrl?: string; storagePath?: string; error?: string }> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;

  if (!view.canEdit) return { ok: false, error: view.windowMessage };

  const ticket = await store.participant.createDeckUploadTicket(token, {
    originalFilename: input.filename,
    byteSize: input.byteSize,
    mimeType: input.mimeType,
  });

  if (!ticket.ok) return { ok: false, error: ticket.error };
  // The upload token is carried inside the signed URL; nothing else about the
  // bucket or the credential is handed over.
  return { ok: true, uploadUrl: ticket.uploadUrl, storagePath: ticket.storagePath };
}

/**
 * Step two: take delivery, or refuse it.
 *
 * Asks Storage what is actually there rather than believing the browser. This
 * is the F-7 guarantee in its strongest form — a recorded deck means bytes that
 * have been seen — and it is why the upload is two steps rather than one.
 */
export async function confirmDeckUploadAction(input: {
  storagePath: string;
  filename: string;
}): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;

  if (!view.canEdit) return { ok: false, error: view.windowMessage };

  const result = await store.participant.confirmDeckUpload(token, {
    storagePath: input.storagePath,
    originalFilename: input.filename,
  });

  if (!result.ok) return { ok: false, error: result.error ?? 'The upload could not be confirmed.' };
  return { ok: true };
}

/**
 * Deck upload, server-mediated.
 *
 * Kept for demo mode and for small files, and still the only path the worker
 * and the fixtures use. MIME type, extension, size AND magic bytes are all
 * checked — a client-supplied content type is a claim, not evidence (T9).
 */
export async function uploadDeckAction(formData: FormData): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;

  if (!view.canEdit) return { ok: false, error: view.windowMessage };

  const file = formData.get('deck');
  if (!(file instanceof File)) return { ok: false, error: 'No file was received.' };

  const basic = validateDeckUpload({ name: file.name, type: file.type, size: file.size });
  if (!basic.ok) return { ok: false, error: basic.message };

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!looksLikePdf(head)) {
    return { ok: false, error: 'That file is not a PDF. Export your deck as a PDF and upload it again.' };
  }

  // The bytes go to Storage, and the artifact row is written only if they
  // arrived. This previously recorded the metadata and nothing else — so a team
  // saw "uploaded", the database reported a PDF of the right size, and the
  // bucket was empty. Nobody would have found out until judging.
  let artifact;
  try {
    artifact = await store.participant.uploadDeck(token, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalFilename: file.name,
      mimeType: file.type,
    });
  } catch (error) {
    // A storage failure must read as a failure. Reporting success here is what
    // made the original defect invisible.
    return {
      ok: false,
      error:
        'The upload did not complete, so your deck has not been saved. Try again — ' +
        'if it keeps failing, tell the Outskill team before the deadline.',
    };
  }
  if (!artifact) return { ok: false, error: 'Could not store the upload.' };

  await store.participant.recordActivity(token, 'deck_replaced');
  revalidatePath('/submit/portal');
  return { ok: true };
}

export async function setDemoVideoAction(url: string): Promise<ActionResult> {
  const resolved = await resolveOwnSubmission();
  if (!resolved) return { ok: false, error: SESSION_EXPIRED };
  const { store, view, token } = resolved;
  if (!view.canEdit) return { ok: false, error: view.windowMessage };

  const validation = validateDemoVideoUrl(url);
  if (!validation.ok) return { ok: false, error: validation.message };

  const artifact = await store.participant.attachArtifact(token, {
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
  if (!artifact) return { ok: false, error: 'Could not save the link.' };

  await store.participant.recordActivity(token, 'demo_link_saved');
  revalidatePath('/submit/portal');
  return { ok: true };
}

/** Record that the team reached a step. Best-effort; never blocks editing. */
export async function recordActivityAction(
  kind: TeamActivityKind,
  section?: string,
): Promise<void> {
  const token = await sessionToken();
  if (!token) return;
  await (await getStoreAsync()).participant.recordActivity(token, kind, section ?? null);
}

/** Server-side completeness, for the review screen. */
export async function getCompletenessAction() {
  const resolved = await resolveOwnSubmission();
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
