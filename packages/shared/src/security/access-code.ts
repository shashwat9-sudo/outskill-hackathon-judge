/**
 * Team access codes.
 *
 * Production learners reach one common URL (`/submit`) and identify their team
 * with a group number plus a shared access code. The code is the team's only
 * credential, so it is treated like a password rather than like a token:
 *
 *   - generated from a CSPRNG;
 *   - hashed with Argon2id, never stored or recoverable in plaintext;
 *   - versioned, so regenerating invalidates every session issued under the old
 *     code without needing to find those sessions;
 *   - shown exactly once, at generation time.
 *
 * Unlike the 256-bit invite token, an access code is short enough for a person
 * to read out, which is precisely why it needs a slow hash and rate limiting.
 */

import { randomInt } from 'node:crypto';
import { hashPassword, verifyPassword } from './password';
import {
  ACCESS_CODE_ALPHABET as ALPHABET,
  ACCESS_CODE_GROUP_SIZE,
  ACCESS_CODE_LENGTH,
} from './access-code-constants';

// Re-exported so server code has one import for everything access-code related.
export { ACCESS_CODE_LENGTH, ACCESS_CODE_GROUP_SIZE, GENERIC_VERIFICATION_ERROR } from './access-code-constants';

export interface GeneratedAccessCode {
  /** Shown once, never stored. */
  code: string;
  /** Human-readable grouping, e.g. ABCD-EFGH-JKMN. */
  formatted: string;
  /** What is stored. */
  hash: string;
}

/**
 * Generate a code.
 *
 * `randomInt` is used rather than `randomBytes % alphabet.length` — the modulo
 * would bias towards the first characters of the alphabet, which is exactly the
 * kind of quiet entropy loss that never shows up in a test.
 */
export async function generateAccessCode(): Promise<GeneratedAccessCode> {
  let code = '';
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return { code, formatted: formatAccessCode(code), hash: await hashPassword(code) };
}

/** Group for readability: ABCD-EFGH-JKMN. */
export function formatAccessCode(code: string): string {
  const normalised = normaliseAccessCode(code);
  const groups: string[] = [];
  for (let i = 0; i < normalised.length; i += ACCESS_CODE_GROUP_SIZE) {
    groups.push(normalised.slice(i, i + ACCESS_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Normalise what a participant typed.
 *
 * People paste the formatted version, type lowercase, and add spaces or hyphens
 * — all three work. Anything outside the alphabet is dropped rather than
 * "corrected": O, 0, I, 1, L and U never appear in a generated code, so an
 * occurrence is a misreading, and guessing which character was meant would make
 * verification unpredictable. A dropped character simply fails the length check
 * and the team retypes it.
 */
export function normaliseAccessCode(input: string): string {
  return (input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .split('')
    .filter((character) => ALPHABET.includes(character))
    .join('');
}

/**
 * Verify a submitted code against a stored hash.
 *
 * Returns false rather than throwing on any error, so a malformed stored hash
 * cannot produce a 500 that distinguishes one team from another.
 */
export async function verifyAccessCode(submitted: string, storedHash: string): Promise<boolean> {
  const normalised = normaliseAccessCode(submitted);
  if (normalised.length !== ACCESS_CODE_LENGTH) return false;
  return verifyPassword(normalised, storedHash);
}

export function isWellFormedAccessCode(input: string): boolean {
  return normaliseAccessCode(input).length === ACCESS_CODE_LENGTH;
}

// --------------------------------------------------------------------------
// Verification rate limiting
// --------------------------------------------------------------------------

/**
 * Attempts are counted per (hashed IP + group number) over a short window.
 *
 * Keyed on both so that one hostile client cannot lock out a legitimate team,
 * and one team's fumbling cannot lock out an entire office behind a NAT.
 */
export const VERIFY_WINDOW_MS = 15 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 8;
export const VERIFY_LOCKOUT_MS = 15 * 60_000;

export interface VerificationAttemptState {
  attempts: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may try again. Zero when allowed. */
  retryAfterSeconds: number;
  state: VerificationAttemptState;
}

export function evaluateVerificationAttempt(
  state: VerificationAttemptState | null,
  now: Date = new Date(),
): RateLimitDecision {
  const fresh: VerificationAttemptState = {
    attempts: 0,
    windowStartedAt: now,
    lockedUntil: null,
  };
  const current = state ?? fresh;

  if (current.lockedUntil && current.lockedUntil.getTime() > now.getTime()) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((current.lockedUntil.getTime() - now.getTime()) / 1000),
      state: current,
    };
  }

  // The window has rolled over — start counting again.
  if (now.getTime() - current.windowStartedAt.getTime() > VERIFY_WINDOW_MS) {
    return { allowed: true, retryAfterSeconds: 0, state: fresh };
  }

  return { allowed: current.attempts < VERIFY_MAX_ATTEMPTS, retryAfterSeconds: 0, state: current };
}

export function registerFailedVerification(
  state: VerificationAttemptState | null,
  now: Date = new Date(),
): VerificationAttemptState {
  const decision = evaluateVerificationAttempt(state, now);
  const attempts = decision.state.attempts + 1;

  return {
    attempts,
    windowStartedAt: decision.state.windowStartedAt,
    // A temporary lockout, never a permanent one — a legitimate team must
    // always be able to get back in, and an admin can clear it sooner.
    lockedUntil: attempts >= VERIFY_MAX_ATTEMPTS ? new Date(now.getTime() + VERIFY_LOCKOUT_MS) : null,
  };
}

export function clearVerificationAttempts(now: Date = new Date()): VerificationAttemptState {
  return { attempts: 0, windowStartedAt: now, lockedUntil: null };
}
