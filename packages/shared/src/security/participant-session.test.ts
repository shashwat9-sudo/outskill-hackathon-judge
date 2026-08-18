import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_GRACE_MS,
  PARTICIPANT_PENDING_COOKIE,
  VERIFICATION_HANDLE_TTL_MS,
  pendingCookieOptions,
  readVerificationHandle,
  signVerificationHandle,
  MAX_EDITOR_NAME_LENGTH,
  PARTICIPANT_SESSION_COOKIE,
  computeSessionExpiry,
  evaluateParticipantSession,
  generateParticipantSessionToken,
  hashParticipantSessionToken,
  participantCookieOptions,
  participantSessionMatches,
  validateEditorIdentity,
} from './participant-session';

/**
 * The session is what lets the access code stay out of the URL, out of history,
 * out of analytics and out of logs. These tests cover the properties that keep
 * that true, plus the revocation lever that makes regenerating a code cheap.
 */

describe('token generation', () => {
  it('mints a high-entropy URL-safe token', () => {
    const { token } = generateParticipantSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url.
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateParticipantSessionToken().token));
    expect(tokens.size).toBe(200);
  });

  it('stores a hash, not the token', () => {
    const { token, tokenHash } = generateParticipantSessionToken();
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('token matching', () => {
  it('matches the token it was minted from', () => {
    const { token, tokenHash } = generateParticipantSessionToken();
    expect(participantSessionMatches(token, tokenHash)).toBe(true);
  });

  it('rejects a different token', () => {
    const a = generateParticipantSessionToken();
    const b = generateParticipantSessionToken();
    expect(participantSessionMatches(b.token, a.tokenHash)).toBe(false);
  });

  it('rejects empty and malformed stored hashes without throwing', () => {
    const { token } = generateParticipantSessionToken();
    expect(participantSessionMatches(token, '')).toBe(false);
    expect(participantSessionMatches(token, 'zz')).toBe(false);
    expect(participantSessionMatches('', '')).toBe(false);
  });

  it('produces a different hash under a secret, so a leaked table is not enough', () => {
    const { token } = generateParticipantSessionToken();
    const unkeyed = hashParticipantSessionToken(token);
    const keyed = hashParticipantSessionToken(token, 'session-secret');
    expect(keyed).not.toBe(unkeyed);
    expect(participantSessionMatches(token, keyed, 'session-secret')).toBe(true);
    // A hash computed under the secret must not validate without it.
    expect(participantSessionMatches(token, keyed)).toBe(false);
  });
});

describe('verification handles', () => {
  const SECRET = 'server-secret-not-known-to-any-client';
  const TEAM = 'f1e2d3c4-0000-4000-8000-000000000001';
  const t0 = new Date('2026-03-13T10:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('round-trips the verified team', () => {
    const handle = signVerificationHandle(TEAM, SECRET, t0);
    expect(readVerificationHandle(handle, SECRET, t0)).toEqual({ valid: true, teamId: TEAM });
  });

  it('cannot be forged without the secret', () => {
    // This is the whole point: a caller who never held the access code must not
    // be able to assemble a handle for a team they learned the id of.
    const forged = `${TEAM}.${t0.getTime() + 600_000}.${'a'.repeat(64)}`;
    expect(readVerificationHandle(forged, SECRET, t0).valid).toBe(false);
  });

  it('rejects a handle signed with a different secret', () => {
    const handle = signVerificationHandle(TEAM, 'some-other-secret', t0);
    expect(readVerificationHandle(handle, SECRET, t0).valid).toBe(false);
  });

  it('rejects a handle whose team was swapped after signing', () => {
    const handle = signVerificationHandle(TEAM, SECRET, t0);
    const [, expiry, signature] = handle.split('.');
    const swapped = `f1e2d3c4-0000-4000-8000-000000000002.${expiry}.${signature}`;
    expect(readVerificationHandle(swapped, SECRET, t0).valid).toBe(false);
  });

  it('rejects a handle whose expiry was pushed out after signing', () => {
    const handle = signVerificationHandle(TEAM, SECRET, t0);
    const [teamId, , signature] = handle.split('.');
    const extended = `${teamId}.${t0.getTime() + 86_400_000}.${signature}`;
    expect(readVerificationHandle(extended, SECRET, t0).valid).toBe(false);
  });

  it('expires, so a handle left in a closed tab is useless later', () => {
    const handle = signVerificationHandle(TEAM, SECRET, t0);
    expect(readVerificationHandle(handle, SECRET, at(VERIFICATION_HANDLE_TTL_MS - 1000)).valid).toBe(
      true,
    );
    expect(readVerificationHandle(handle, SECRET, at(VERIFICATION_HANDLE_TTL_MS + 1000)).valid).toBe(
      false,
    );
  });

  it('rejects malformed input without throwing', () => {
    for (const handle of ['', 'nonsense', 'a.b', 'a.b.c.d', `${TEAM}.notanumber.abcd`, 'a.1.zz']) {
      expect(readVerificationHandle(handle, SECRET, t0), handle).toEqual({
        valid: false,
        teamId: null,
      });
    }
  });

  it('never reveals a team id from a handle it rejected', () => {
    const expired = signVerificationHandle(TEAM, SECRET, new Date(t0.getTime() - 86_400_000));
    expect(readVerificationHandle(expired, SECRET, t0).teamId).toBeNull();
  });

  it('is carried in a cookie scoped away from the admin surface', () => {
    const options = pendingCookieOptions(true, t0);
    expect(PARTICIPANT_PENDING_COOKIE).toBe('ohj_team_pending');
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/submit');
    expect(options.sameSite).toBe('lax');
    // The cookie must not outlive the assertion inside it.
    expect(options.expires.getTime()).toBe(t0.getTime() + VERIFICATION_HANDLE_TTL_MS);
  });
});

describe('editor identity', () => {
  it('accepts an ordinary name', () => {
    const result = validateEditorIdentity('Priya Raman', 'Backend');
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ name: 'Priya Raman', role: 'Backend' });
  });

  it('treats a missing role as absent rather than empty', () => {
    expect(validateEditorIdentity('Arjun').value).toEqual({ name: 'Arjun', role: null });
    expect(validateEditorIdentity('Arjun', '   ').value?.role).toBeNull();
  });

  it('asks for a name in plain language', () => {
    const result = validateEditorIdentity(' ');
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatch(/whoever is editing/i);
    // Never "Required" or "invalid input".
    expect(result.problems[0]).not.toMatch(/^required$|invalid/i);
  });

  it('bounds the length', () => {
    expect(validateEditorIdentity('x'.repeat(MAX_EDITOR_NAME_LENGTH + 1)).valid).toBe(false);
    expect(validateEditorIdentity('x'.repeat(MAX_EDITOR_NAME_LENGTH)).valid).toBe(true);
  });

  it('rejects control characters that would corrupt the activity panel or a CSV', () => {
    // Built from char codes rather than written literally: a control character
    // in source is invisible, and it makes tooling treat the file as binary.
    const CONTROLS = [0, 7, 9, 10, 13, 27, 127].map((code) => String.fromCharCode(code));
    for (const control of CONTROLS) {
      expect(
        validateEditorIdentity(`Priya${control}Raman`).valid,
        `char code ${control.charCodeAt(0)} was accepted`,
      ).toBe(false);
    }
  });

  it('accepts names outside ASCII', () => {
    // A learner cohort in India will have names this must not reject.
    expect(validateEditorIdentity('प्रिया').valid).toBe(true);
    expect(validateEditorIdentity("O'Sullivan").valid).toBe(true);
  });
});

describe('session lifetime', () => {
  const now = new Date('2026-03-13T10:00:00Z');

  it('outlives the deadline by a grace period, so a receipt stays reachable', () => {
    const deadline = new Date('2026-03-13T18:29:00Z');
    const expiry = computeSessionExpiry(deadline, now);
    expect(expiry.getTime()).toBe(deadline.getTime() + DEFAULT_SESSION_GRACE_MS);
  });

  it('still gives an hour to a session created moments before closing', () => {
    const deadline = new Date('2026-03-13T10:00:30Z');
    const expiry = computeSessionExpiry(deadline, now, 0);
    expect(expiry.getTime()).toBeGreaterThanOrEqual(now.getTime() + 60 * 60 * 1000);
  });

  it('caps a distant deadline rather than minting a near-permanent cookie', () => {
    const distant = new Date('2027-01-01T00:00:00Z');
    const expiry = computeSessionExpiry(distant, now);
    expect(expiry.getTime()).toBeLessThanOrEqual(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  });
});

describe('session validity', () => {
  const now = new Date('2026-03-13T10:00:00Z');
  const live = {
    expiresAt: new Date('2026-03-14T10:00:00Z'),
    revokedAt: null as Date | null,
    accessCodeVersion: 1,
  };

  it('accepts a live session', () => {
    expect(evaluateParticipantSession(live, 1, now)).toEqual({ valid: true, reason: 'ok' });
  });

  it('rejects an unknown session', () => {
    expect(evaluateParticipantSession(null, 1, now).reason).toBe('unknown');
  });

  it('rejects a revoked session', () => {
    const revoked = { ...live, revokedAt: new Date('2026-03-13T09:00:00Z') };
    expect(evaluateParticipantSession(revoked, 1, now).reason).toBe('revoked');
  });

  it('rejects an expired session, boundary included', () => {
    expect(evaluateParticipantSession({ ...live, expiresAt: now }, 1, now).reason).toBe('expired');
  });

  it('invalidates every session when the access code is regenerated', () => {
    // The revocation lever: bump the version, and sessions minted under the old
    // code stop working without anyone having to find them.
    const result = evaluateParticipantSession(live, 2, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('code_rotated');
  });

  it('checks revocation before expiry, so the reason is the real one', () => {
    const both = { ...live, revokedAt: new Date('2026-03-01T00:00:00Z'), expiresAt: now };
    expect(evaluateParticipantSession(both, 1, now).reason).toBe('revoked');
  });
});

describe('the cookie', () => {
  const expiry = new Date('2026-03-14T18:29:00Z');

  it('is scoped so it never reaches the admin surface', () => {
    const options = participantCookieOptions(expiry, true);
    expect(options.path).toBe('/submit');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.secure).toBe(true);
  });

  it('carries no team identity in its name', () => {
    expect(PARTICIPANT_SESSION_COOKIE).toBe('ohj_team_session');
    expect(PARTICIPANT_SESSION_COOKIE).not.toMatch(/\d/);
  });

  it('allows an insecure cookie only when explicitly asked, for local http', () => {
    expect(participantCookieOptions(expiry, false).secure).toBe(false);
  });
});
