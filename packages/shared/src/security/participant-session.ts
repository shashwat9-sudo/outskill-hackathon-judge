/**
 * Participant sessions.
 *
 * After a team verifies its group number and access code, it gets a session
 * rather than carrying the code around. The code must never appear in a URL,
 * in history, in analytics, in logs, in an error, in audit metadata, or in
 * client-side persistent storage — a session cookie is the only thing that
 * travels.
 *
 * The session is an opaque random token; only its hash is stored, exactly like
 * the admin session. A signed self-describing token was rejected deliberately:
 * a stored session can be revoked, and revocation is a stated requirement.
 *
 * `accessCodeVersion` is what makes regeneration cheap. Bumping a team's code
 * version invalidates every session issued under the old code without having to
 * find and delete them.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashInviteToken } from './crypto';

const SESSION_TOKEN_BYTES = 32;

export interface GeneratedParticipantSession {
  /** Goes in the cookie. Never stored. */
  token: string;
  /** What is stored. */
  tokenHash: string;
}

export function generateParticipantSessionToken(): GeneratedParticipantSession {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashParticipantSessionToken(token) };
}

/**
 * Hash the session token with a keyed HMAC.
 *
 * Keyed rather than plain SHA-256 so a leaked database alone does not let an
 * attacker precompute lookups against captured cookies.
 */
export function hashParticipantSessionToken(token: string, secret?: string): string {
  if (!secret) return hashInviteToken(token);
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

export function participantSessionMatches(
  candidate: string,
  storedHash: string,
  secret?: string,
): boolean {
  const a = Buffer.from(hashParticipantSessionToken(candidate, secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------
// Verification handles
// --------------------------------------------------------------------------

/**
 * The bridge between "you proved you hold the code" and "here is your session".
 *
 * Entry is two steps: verify the code, then say who is editing. Something has to
 * carry the verified team across that gap, and it must not be the access code
 * again (it would then be posted twice) nor a bare team id (anyone who learned
 * or guessed one could mint a session without ever holding the code).
 *
 * So it is a signed, short-lived assertion: team id, expiry, HMAC. Unforgeable
 * without the server secret, and useless minutes later.
 */
export const VERIFICATION_HANDLE_TTL_MS = 10 * 60 * 1000;
export const PARTICIPANT_PENDING_COOKIE = 'ohj_team_pending';

export function signVerificationHandle(
  teamId: string,
  secret: string,
  now: Date = new Date(),
): string {
  const expiresAt = now.getTime() + VERIFICATION_HANDLE_TTL_MS;
  const body = `${teamId}.${expiresAt}`;
  return `${body}.${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export interface VerificationHandleResult {
  valid: boolean;
  teamId: string | null;
}

/**
 * Check a handle.
 *
 * Returns a plain invalid result for a malformed, expired or wrongly signed
 * handle — all three mean the same thing to the caller: start over.
 */
export function readVerificationHandle(
  handle: string,
  secret: string,
  now: Date = new Date(),
): VerificationHandleResult {
  const invalid: VerificationHandleResult = { valid: false, teamId: null };
  const parts = (handle ?? '').split('.');
  if (parts.length !== 3) return invalid;

  const [teamId, expiresAtRaw, signature] = parts as [string, string, string];
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return invalid;

  const expected = createHmac('sha256', secret).update(`${teamId}.${expiresAtRaw}`, 'utf8').digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length) return invalid;
  if (!timingSafeEqual(provided, expected)) return invalid;

  return { valid: true, teamId };
}

export function pendingCookieOptions(secure: boolean, now: Date = new Date()) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/submit',
    expires: new Date(now.getTime() + VERIFICATION_HANDLE_TTL_MS),
  };
}

// --------------------------------------------------------------------------
// Editor identity
// --------------------------------------------------------------------------

/**
 * The editor's name is an ACTIVITY LABEL, not verified identity.
 *
 * Anyone holding the shared code can type any name. It exists so a team can see
 * who changed what, not so the system can attribute anything. Nothing security-
 * relevant may depend on it, and it is never used for authorisation.
 */
export const MAX_EDITOR_NAME_LENGTH = 80;
export const MAX_EDITOR_ROLE_LENGTH = 80;

export interface EditorIdentity {
  name: string;
  role: string | null;
}

export interface EditorValidation {
  valid: boolean;
  problems: string[];
  value: EditorIdentity | null;
}

export function validateEditorIdentity(name: string, role?: string): EditorValidation {
  const problems: string[] = [];
  const trimmedName = (name ?? '').trim();
  const trimmedRole = (role ?? '').trim();

  if (trimmedName.length < 2) {
    problems.push('Enter the name of whoever is editing right now.');
  }
  if (trimmedName.length > MAX_EDITOR_NAME_LENGTH) {
    problems.push(`Keep the name to ${MAX_EDITOR_NAME_LENGTH} characters or fewer.`);
  }
  if (trimmedRole.length > MAX_EDITOR_ROLE_LENGTH) {
    problems.push(`Keep the role to ${MAX_EDITOR_ROLE_LENGTH} characters or fewer.`);
  }
  // Control characters would corrupt the activity panel and any CSV export.
  // Escaped rather than literal: a control character in source is invisible.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
  if (CONTROL_CHARS.test(trimmedName) || CONTROL_CHARS.test(trimmedRole)) {
    problems.push('Remove any unusual characters from the name or role.');
  }

  return {
    valid: problems.length === 0,
    problems,
    value: problems.length === 0 ? { name: trimmedName, role: trimmedRole || null } : null,
  };
}

// --------------------------------------------------------------------------
// Lifetime
// --------------------------------------------------------------------------

/** Extra time after the submission window closes, so a receipt stays reachable. */
export const DEFAULT_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A session expires at the end of the submission window plus a grace period,
 * capped so a very distant deadline does not mint a near-permanent cookie.
 */
export function computeSessionExpiry(
  effectiveDeadline: Date,
  now: Date = new Date(),
  graceMs: number = DEFAULT_SESSION_GRACE_MS,
): Date {
  const MAX_SESSION_MS = 14 * 24 * 60 * 60 * 1000;
  const windowEnd = effectiveDeadline.getTime() + graceMs;
  const cap = now.getTime() + MAX_SESSION_MS;
  // At least an hour, so a session created moments before closing still works.
  const floor = now.getTime() + 60 * 60 * 1000;
  return new Date(Math.max(floor, Math.min(windowEnd, cap)));
}

export interface ParticipantSessionValidity {
  valid: boolean;
  reason: 'ok' | 'expired' | 'revoked' | 'code_rotated' | 'unknown';
}

/**
 * Decide whether a stored session is still usable.
 *
 * `currentAccessCodeVersion` is the revocation lever: when a team's code is
 * regenerated the version increments, and every session minted under the old
 * version stops working immediately.
 */
export function evaluateParticipantSession(
  session: {
    expiresAt: Date;
    revokedAt: Date | null;
    accessCodeVersion: number;
  } | null,
  currentAccessCodeVersion: number,
  now: Date = new Date(),
): ParticipantSessionValidity {
  if (!session) return { valid: false, reason: 'unknown' };
  if (session.revokedAt) return { valid: false, reason: 'revoked' };
  if (session.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: 'expired' };
  if (session.accessCodeVersion !== currentAccessCodeVersion) {
    return { valid: false, reason: 'code_rotated' };
  }
  return { valid: true, reason: 'ok' };
}

export const PARTICIPANT_SESSION_COOKIE = 'ohj_team_session';

/**
 * Cookie attributes.
 *
 * Scoped to `/submit` so the participant cookie is never sent to `/admin`, and
 * `SameSite=Lax` so a cross-site form post cannot act as a team.
 */
export function participantCookieOptions(expiresAt: Date, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/submit',
    expires: expiresAt,
  };
}
