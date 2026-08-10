/**
 * Shared-admin password handling (Argon2id).
 *
 * There is exactly one admin account and no signup. Rotation requires the
 * current password. Plaintext is never stored, never logged, and never leaves
 * the function that receives it.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Argon2id, spelled as its numeric variant.
 *
 * `@node-rs/argon2` exposes `Algorithm` as an ambient const enum, which cannot
 * be referenced under `isolatedModules`. The variant ordering is fixed by the
 * Argon2 specification (0 = Argon2d, 1 = Argon2i, 2 = Argon2id).
 */
const ARGON2ID = 2;

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  const validation = validatePasswordStrength(plaintext);
  if (!validation.ok) {
    throw new Error(`Refusing to hash a weak password: ${validation.problems.join(' ')}`);
  }
  return argon2Hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false on any error rather than throwing, so a
 * malformed stored hash cannot turn into a 500 that distinguishes accounts.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (!plaintext || !storedHash) return false;
  try {
    return await argon2Verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

export interface PasswordStrengthResult {
  ok: boolean;
  problems: string[];
}

/**
 * Deliberately simple rules. This account is shared by an internal team, so the
 * real controls are lockout, rate limiting, and rotation — not composition
 * rules that push people towards `Password1!`.
 */
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password123',
  'administrator',
  'outskill',
  'outskill123',
  'changeme',
  'letmein',
  'qwertyuiop',
  '123456789012',
]);

export function validatePasswordStrength(plaintext: string): PasswordStrengthResult {
  const problems: string[] = [];
  const value = plaintext ?? '';

  if (value.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (OBVIOUS_PASSWORDS.has(value.toLowerCase())) {
    problems.push('This password is too common.');
  }
  if (/^(.)\1+$/.test(value)) {
    problems.push('Do not use a single repeated character.');
  }
  if (value.trim().length !== value.length) {
    problems.push('Remove leading or trailing spaces.');
  }

  return { ok: problems.length === 0, problems };
}

// --------------------------------------------------------------------------
// Lockout policy
// --------------------------------------------------------------------------

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export function isLockedOut(state: LockoutState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function lockoutRemainingSeconds(state: LockoutState, now: Date = new Date()): number {
  if (!state.lockedUntil) return 0;
  return Math.max(0, Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000));
}

export function registerFailedAttempt(state: LockoutState, now: Date = new Date()): LockoutState {
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000),
    };
  }
  return { failedAttempts, lockedUntil: state.lockedUntil };
}

export function registerSuccessfulLogin(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
