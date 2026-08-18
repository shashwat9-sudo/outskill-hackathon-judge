import 'server-only';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  csrfTokenMatches,
  generateCsrfToken,
  generateSessionToken,
  hashIdentifier,
  hashPassword,
  isLockedOut,
  lockoutRemainingSeconds,
  registerFailedAttempt,
  registerSuccessfulLogin,
  validatePasswordStrength,
  verifyPassword,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';

/**
 * Shared-admin authentication.
 *
 * One account, no signup. Sessions are opaque tokens; only their hash is
 * stored. Every action is audited as `shared-admin` — which, by design, cannot
 * identify which member of the team performed it. That limitation is documented
 * in the playbook and in the threat model (T6).
 */

const SESSION_COOKIE = 'ohj_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day

export interface AdminSessionContext {
  sessionId: string;
  csrfToken: string;
  username: string;
}

async function requestFingerprint(): Promise<{ ipHash: string | null; userAgentHash: string | null }> {
  const headerList = await headers();
  const salt = getEnvConfig().ADMIN_SESSION_SECRET ?? 'demo-salt';
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = headerList.get('user-agent');
  return {
    ipHash: ip ? hashIdentifier(ip, salt) : null,
    userAgentHash: userAgent ? hashIdentifier(userAgent, salt) : null,
  };
}

/**
 * Ensure the single shared admin exists.
 *
 * In demo mode a default credential is seeded so the platform can be
 * demonstrated immediately; outside demo mode the seed values must come from
 * the environment and the process refuses to invent one.
 */
export async function ensureAdminAccount(): Promise<void> {
  const store = await getStoreAsync();
  const env = getEnvConfig();
  const existing = await store.adminAuth.getAdminAccount();
  if (existing) return;

  const username = env.ADMIN_SEED_USERNAME || (env.DEMO_MODE ? 'outskill-admin' : '');
  const password = env.ADMIN_SEED_PASSWORD || (env.DEMO_MODE ? 'demo-admin-password' : '');

  if (!username || !password) {
    throw new Error(
      'No admin account exists and ADMIN_SEED_USERNAME / ADMIN_SEED_PASSWORD are not set. Set them, then restart.',
    );
  }
  await store.adminAuth.createAdminAccount(username, await hashPassword(password));
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export async function loginAdmin(username: string, password: string): Promise<LoginResult> {
  const store = await getStoreAsync();
  await ensureAdminAccount();
  const account = await store.adminAuth.getAdminAccount();

  // Deliberately identical failure text throughout, so a wrong username and a
  // wrong password are indistinguishable.
  const genericFailure: LoginResult = { ok: false, error: 'Incorrect username or password.' };
  if (!account) return genericFailure;

  const lockoutState = { failedAttempts: account.failedAttempts, lockedUntil: account.lockedUntil };
  if (isLockedOut(lockoutState)) {
    const seconds = lockoutRemainingSeconds(lockoutState);
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
    };
  }

  const usernameMatches = account.username.toLowerCase() === username.trim().toLowerCase();
  const passwordMatches = await verifyPassword(password, account.passwordHash);

  if (!usernameMatches || !passwordMatches) {
    const next = registerFailedAttempt(lockoutState);
    await store.adminAuth.updateAdminLockout(next);
    await store.audit.record({
      actorType: 'shared-admin',
      actorRef: 'shared-admin',
      action: 'admin.login.failed',
      entityType: 'admin_account',
      entityId: account.id,
      cohortId: null,
      before: null,
      after: { failedAttempts: next.failedAttempts },
      ...(await requestFingerprint()),
    });
    return genericFailure;
  }

  await store.adminAuth.updateAdminLockout(registerSuccessfulLogin());
  await store.adminAuth.recordSuccessfulLogin();

  // Session rotation: a fresh id is minted on every login, so a pre-login
  // fixation attempt cannot survive authentication.
  const previous = await readSessionCookie();
  if (previous) {
    const old = await store.adminAuth.getSessionByHash(previous.hash);
    if (old) await store.adminAuth.revokeSession(old.id);
  }

  const { token, tokenHash } = generateSessionToken();
  const csrfToken = generateCsrfToken();
  const fingerprint = await requestFingerprint();
  const session = await store.adminAuth.createSession({
    sessionTokenHash: tokenHash,
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    rotatedFrom: null,
    ...fingerprint,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: getEnvConfig().NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  await store.audit.record({
    actorType: 'shared-admin',
    actorRef: 'shared-admin',
    action: 'admin.login.succeeded',
    entityType: 'admin_session',
    entityId: session.id,
    cohortId: null,
    before: null,
    after: null,
    ...fingerprint,
  });

  return { ok: true };
}

async function readSessionCookie(): Promise<{ token: string; hash: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const { hashInviteToken } = await import('@ohj/shared');
  return { token, hash: hashInviteToken(token) };
}

export async function getAdminSession(): Promise<AdminSessionContext | null> {
  const cookie = await readSessionCookie();
  if (!cookie) return null;

  const store = await getStoreAsync();
  const session = await store.adminAuth.getSessionByHash(cookie.hash);
  if (!session) return null;

  const account = await store.adminAuth.getAdminAccount();
  if (!account) return null;

  return { sessionId: session.id, csrfToken: session.csrfToken, username: account.username };
}

/** Guard for every admin page and action. Redirects rather than throwing. */
export async function requireAdmin(): Promise<AdminSessionContext> {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  return session;
}

export async function logoutAdmin(): Promise<void> {
  const session = await getAdminSession();
  if (session) {
    await (await getStoreAsync()).adminAuth.revokeSession(session.sessionId);
  }
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * CSRF check for state-changing admin actions.
 *
 * Throws rather than returning false: a caller that forgets to check the return
 * value would silently accept forged requests.
 */
export async function assertCsrf(submittedToken: string | null | undefined): Promise<void> {
  const session = await getAdminSession();
  if (!session) throw new Error('Not signed in.');
  if (!submittedToken || !csrfTokenMatches(submittedToken, session.csrfToken)) {
    throw new Error('This request could not be verified. Reload the page and try again.');
  }
}

export interface RotationResult {
  ok: boolean;
  error?: string;
}

/**
 * Rotate the shared credential.
 *
 * Requires the current password, and revokes every other session so a departing
 * team member's browser stops working immediately — which is the entire point
 * of rotating a shared credential.
 */
export async function rotateAdminCredentials(input: {
  currentPassword: string;
  newUsername?: string;
  newPassword?: string;
}): Promise<RotationResult> {
  const store = await getStoreAsync();
  const account = await store.adminAuth.getAdminAccount();
  if (!account) return { ok: false, error: 'No admin account exists.' };

  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    return { ok: false, error: 'The current password is incorrect.' };
  }

  const patch: { username?: string; passwordHash?: string } = {};

  if (input.newUsername && input.newUsername.trim() !== account.username) {
    const username = input.newUsername.trim();
    if (username.length < 3) return { ok: false, error: 'The username must be at least 3 characters.' };
    patch.username = username;
  }

  if (input.newPassword) {
    const strength = validatePasswordStrength(input.newPassword);
    if (!strength.ok) return { ok: false, error: strength.problems.join(' ') };
    if (await verifyPassword(input.newPassword, account.passwordHash)) {
      return { ok: false, error: 'The new password must differ from the current one.' };
    }
    patch.passwordHash = await hashPassword(input.newPassword);
  }

  if (!patch.username && !patch.passwordHash) {
    return { ok: false, error: 'Nothing to change.' };
  }

  await store.adminAuth.rotateCredentials(patch);
  await store.audit.record({
    actorType: 'shared-admin',
    actorRef: 'shared-admin',
    action: 'admin.credentials.rotated',
    entityType: 'admin_account',
    entityId: account.id,
    cohortId: null,
    before: null,
    // Never record the values, only which fields moved.
    after: { usernameChanged: Boolean(patch.username), passwordChanged: Boolean(patch.passwordHash) },
    ...(await requestFingerprint()),
  });

  if (patch.passwordHash) {
    await store.adminAuth.revokeAllSessions();
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE);
  }

  return { ok: true };
}

/** Convenience wrapper so every admin mutation lands in the audit log. */
export async function auditAdminAction(input: {
  action: string;
  entityType: string;
  entityId: string | null;
  cohortId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void> {
  await (await getStoreAsync()).audit.record({
    actorType: 'shared-admin',
    actorRef: 'shared-admin',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    cohortId: input.cohortId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    ...(await requestFingerprint()),
  });
}
