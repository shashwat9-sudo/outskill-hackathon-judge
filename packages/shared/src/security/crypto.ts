/**
 * Credential encryption (AES-256-GCM) and invite-token handling.
 *
 * Participant demo credentials grant access to systems Outskill does not own.
 * They are encrypted at rest, decrypted only in the worker at the moment of
 * use, never logged, and never included in an AI payload (ADR-009).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const AUTH_TAG_BYTES = 16;

export interface EncryptedEnvelope {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export class CryptoConfigError extends Error {
  override readonly name = 'CryptoConfigError';
}

/**
 * Parse and validate the base64 encryption key.
 *
 * Fails loudly on a wrong-length key rather than silently deriving something —
 * a key that "works" but is not the configured one produces unreadable data.
 */
export function parseEncryptionKey(base64Key: string | undefined): Buffer {
  if (!base64Key || base64Key.trim().length === 0) {
    throw new CryptoConfigError(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(base64Key.trim(), 'base64');
  } catch {
    throw new CryptoConfigError('CREDENTIAL_ENCRYPTION_KEY is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes; got ${key.length}.`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, keyVersion = 1): EncryptedEnvelope {
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(`Encryption key must be ${KEY_BYTES} bytes.`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

export function decryptSecret(envelope: EncryptedEnvelope, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(`Encryption key must be ${KEY_BYTES} bytes.`);
  }
  if (envelope.iv.length !== IV_BYTES) {
    throw new CryptoConfigError(`IV must be ${IV_BYTES} bytes; got ${envelope.iv.length}.`);
  }
  if (envelope.authTag.length !== AUTH_TAG_BYTES) {
    throw new CryptoConfigError(
      `Auth tag must be ${AUTH_TAG_BYTES} bytes; got ${envelope.authTag.length}.`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, envelope.iv);
  decipher.setAuthTag(envelope.authTag);
  // Throws on tampering — GCM authenticates, so a modified ciphertext fails here
  // rather than returning garbage.
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
}

/** Compact string form for drivers without a native bytea type (e.g. the memory driver). */
export function serialiseEnvelope(envelope: EncryptedEnvelope): string {
  return [
    `v${envelope.keyVersion}`,
    envelope.iv.toString('base64'),
    envelope.authTag.toString('base64'),
    envelope.ciphertext.toString('base64'),
  ].join('.');
}

export function deserialiseEnvelope(serialised: string): EncryptedEnvelope {
  const parts = serialised.split('.');
  if (parts.length !== 4) throw new CryptoConfigError('Malformed encrypted envelope.');
  const [versionPart, ivPart, tagPart, cipherPart] = parts as [string, string, string, string];
  if (!versionPart.startsWith('v')) throw new CryptoConfigError('Malformed envelope key version.');
  const keyVersion = Number(versionPart.slice(1));
  if (!Number.isInteger(keyVersion)) throw new CryptoConfigError('Malformed envelope key version.');
  return {
    keyVersion,
    iv: Buffer.from(ivPart, 'base64'),
    authTag: Buffer.from(tagPart, 'base64'),
    ciphertext: Buffer.from(cipherPart, 'base64'),
  };
}

// --------------------------------------------------------------------------
// Invite tokens
// --------------------------------------------------------------------------

const INVITE_TOKEN_BYTES = 32; // 256 bits
export const INVITE_TOKEN_PREFIX_LENGTH = 8;

export interface GeneratedInviteToken {
  /** Shown once, distributed to the team, never stored. */
  token: string;
  /** What we store. */
  tokenHash: string;
  /** Stored so admins can identify a token in the UI without it being usable. */
  tokenPrefix: string;
}

export function generateInviteToken(): GeneratedInviteToken {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashInviteToken(token),
    tokenPrefix: token.slice(0, INVITE_TOKEN_PREFIX_LENGTH),
  };
}

/**
 * SHA-256 is correct here, unlike for passwords: the token already has 256 bits
 * of entropy, so there is nothing to brute-force and no need to slow lookups on
 * the participant hot path.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison — a timing side channel would leak the token. */
export function inviteTokenMatches(candidateToken: string, storedHash: string): boolean {
  const candidateHash = hashInviteToken(candidateToken);
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------
// Session tokens and generic hashing
// --------------------------------------------------------------------------

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function sessionTokenMatches(candidate: string, storedHash: string): boolean {
  return inviteTokenMatches(candidate, storedHash);
}

/**
 * One-way hash for IP addresses and user agents in audit logs.
 * Salted so audit rows cannot be reversed with a rainbow table, while still
 * letting us tell "same origin" from "different origin".
 */
export function hashIdentifier(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${value}`, 'utf8').digest('hex').slice(0, 32);
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function csrfTokenMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// --------------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------------

/**
 * Mask a secret for display in the admin UI.
 * Never reconstructs enough to be useful; revealing is a separate audited action.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 2) return '••';
  if (value.length <= 6) return `${value.slice(0, 1)}${'•'.repeat(value.length - 1)}`;
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(value.length - 2, 10))}`;
}
