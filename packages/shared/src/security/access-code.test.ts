import { describe, expect, it } from 'vitest';
import {
  ACCESS_CODE_LENGTH,
  GENERIC_VERIFICATION_ERROR,
  VERIFY_LOCKOUT_MS,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_WINDOW_MS,
  clearVerificationAttempts,
  evaluateVerificationAttempt,
  formatAccessCode,
  generateAccessCode,
  isWellFormedAccessCode,
  normaliseAccessCode,
  registerFailedVerification,
  verifyAccessCode,
} from './access-code';

/**
 * Team access codes are the only credential a learner has. These tests cover
 * what would actually hurt: a guessable code, a code that survives in plaintext,
 * a normaliser that turns a wrong code into a different wrong code, and rate
 * limiting that either never engages or never releases.
 */

describe('generation', () => {
  it('produces a 12-character code from the unambiguous alphabet', async () => {
    const { code } = await generateAccessCode();
    expect(code).toHaveLength(ACCESS_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{12}$/);
  });

  it('excludes the characters people misread', async () => {
    // 40 codes is 480 characters. If O/0/I/1/L/U were in the alphabet, the odds
    // of none appearing are vanishing.
    const codes = await Promise.all(Array.from({ length: 40 }, () => generateAccessCode()));
    const all = codes.map((c) => c.code).join('');
    for (const forbidden of ['O', '0', 'I', '1', 'L', 'U']) {
      expect(all, `alphabet leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('does not repeat', async () => {
    const codes = await Promise.all(Array.from({ length: 30 }, () => generateAccessCode()));
    expect(new Set(codes.map((c) => c.code)).size).toBe(30);
  });

  it('returns a hash that is not the code', async () => {
    const { code, hash } = await generateAccessCode();
    expect(hash).not.toContain(code);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('formats in three readable groups', async () => {
    const { code, formatted } = await generateAccessCode();
    expect(formatted).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normaliseAccessCode(formatted)).toBe(code);
  });
});

describe('normalisation', () => {
  it('accepts what people actually type', () => {
    const code = 'ABCDEFGHJKMN';
    for (const variant of [
      'ABCD-EFGH-JKMN',
      'abcd-efgh-jkmn',
      'ABCD EFGH JKMN',
      '  abcdefghjkmn  ',
      'ABCD - EFGH - JKMN',
    ]) {
      expect(normaliseAccessCode(variant), variant).toBe(code);
    }
  });

  it('drops out-of-alphabet characters instead of guessing at them', () => {
    // O is not in the alphabet. Mapping it to 0 (also not in the alphabet) or to
    // Q would turn one wrong code into a different wrong code. Dropping it fails
    // the length check, and the team retypes.
    expect(normaliseAccessCode('ABCDEFGHJKMO')).toBe('ABCDEFGHJKM');
    expect(isWellFormedAccessCode('ABCDEFGHJKMO')).toBe(false);
  });

  it('survives empty and nullish input', () => {
    expect(normaliseAccessCode('')).toBe('');
    expect(normaliseAccessCode(undefined as unknown as string)).toBe('');
  });

  it('formats a short string without inventing padding', () => {
    expect(formatAccessCode('ABCDEF')).toBe('ABCD-EF');
  });
});

describe('verification', () => {
  it('accepts the code in any of its typed forms', async () => {
    const { code, formatted, hash } = await generateAccessCode();
    expect(await verifyAccessCode(code, hash)).toBe(true);
    expect(await verifyAccessCode(formatted, hash)).toBe(true);
    expect(await verifyAccessCode(formatted.toLowerCase(), hash)).toBe(true);
  });

  it('rejects a different code', async () => {
    const a = await generateAccessCode();
    const b = await generateAccessCode();
    expect(await verifyAccessCode(b.code, a.hash)).toBe(false);
  });

  it('rejects wrong-length input without hashing it', async () => {
    const { hash } = await generateAccessCode();
    expect(await verifyAccessCode('ABC', hash)).toBe(false);
    expect(await verifyAccessCode('', hash)).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A 500 here would distinguish one team's row from another's.
    await expect(verifyAccessCode('ABCDEFGHJKMN', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('rate limiting', () => {
  const t0 = new Date('2026-01-01T10:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('allows a first attempt with no history', () => {
    const decision = evaluateVerificationAttempt(null, t0);
    expect(decision.allowed).toBe(true);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it('locks out after the configured number of failures', () => {
    let state = null as Parameters<typeof registerFailedVerification>[0];
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) {
      expect(evaluateVerificationAttempt(state, t0).allowed, `attempt ${i + 1}`).toBe(true);
      state = registerFailedVerification(state, t0);
    }

    const blocked = evaluateVerificationAttempt(state, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('releases the lockout rather than making it permanent', () => {
    let state = null as Parameters<typeof registerFailedVerification>[0];
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) state = registerFailedVerification(state, t0);

    expect(evaluateVerificationAttempt(state, at(VERIFY_LOCKOUT_MS - 1000)).allowed).toBe(false);
    // A legitimate team must always be able to get back in.
    expect(evaluateVerificationAttempt(state, at(VERIFY_LOCKOUT_MS + 1000)).allowed).toBe(true);
  });

  it('reports a shrinking retry time', () => {
    let state = null as Parameters<typeof registerFailedVerification>[0];
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) state = registerFailedVerification(state, t0);

    const early = evaluateVerificationAttempt(state, at(60_000)).retryAfterSeconds;
    const later = evaluateVerificationAttempt(state, at(120_000)).retryAfterSeconds;
    expect(later).toBeLessThan(early);
  });

  it('rolls the window over, so slow typing never accumulates into a lockout', () => {
    let state = null as Parameters<typeof registerFailedVerification>[0];
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS - 1; i++) state = registerFailedVerification(state, t0);

    const afterWindow = evaluateVerificationAttempt(state, at(VERIFY_WINDOW_MS + 1000));
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.state.attempts).toBe(0);
  });

  it('lets an admin clear a lockout', () => {
    let state = null as Parameters<typeof registerFailedVerification>[0];
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) state = registerFailedVerification(state, t0);
    expect(evaluateVerificationAttempt(state, t0).allowed).toBe(false);

    expect(evaluateVerificationAttempt(clearVerificationAttempts(t0), t0).allowed).toBe(true);
  });
});

describe('the failure message', () => {
  it('says nothing about which half was wrong', () => {
    // Naming the group number, or saying "no such group", turns the form into a
    // cohort enumeration tool.
    expect(GENERIC_VERIFICATION_ERROR).not.toMatch(/group \d|no such|not found|does not exist/i);
    expect(GENERIC_VERIFICATION_ERROR).toMatch(/group number and access code/i);
  });
});
