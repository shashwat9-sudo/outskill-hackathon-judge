/**
 * Identifier generation.
 *
 * Three kinds of identifier, with deliberately different properties:
 *
 *   - internal ids: uuid, never shown to participants;
 *   - receipt ids: human-readable, unguessable enough to not be enumerable,
 *     and safe to read out over a support call;
 *   - anonymised assessment ids: what an AI provider sees instead of anything
 *     that could identify a team (privacy rule 10).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

// --------------------------------------------------------------------------
// Receipt IDs
// --------------------------------------------------------------------------

/**
 * Crockford base32 without I, L, O, U — removes the characters people misread
 * or mistype when reading a receipt aloud.
 */
const RECEIPT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Receipt format: OSK-<cohort code>-<group>-<random>
 * e.g. OSK-AIAP7-042-K3M9QX
 *
 * The group number is embedded so support can identify a team instantly, and
 * the random tail makes receipts non-enumerable.
 */
export function generateReceiptId(cohortCode: string, groupNumber: number): string {
  const code = cohortCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'COHORT';
  const group = String(groupNumber).padStart(3, '0');
  const random = randomChars(6);
  return `OSK-${code}-${group}-${random}`;
}

function randomChars(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += RECEIPT_ALPHABET[(bytes[i] ?? 0) % RECEIPT_ALPHABET.length];
  }
  return out;
}

export function isValidReceiptId(value: string): boolean {
  return /^OSK-[A-Z0-9]{1,6}-\d{3}-[0-9A-HJKMNP-TV-Z]{6}$/.test(value);
}

// --------------------------------------------------------------------------
// Anonymised assessment IDs
// --------------------------------------------------------------------------

/**
 * The identifier an AI provider sees.
 *
 * Deterministic (so logs correlate across stages and reruns) but derived
 * through a one-way hash with a per-cohort salt, so the provider cannot link
 * the id back to a team and two cohorts never share an id for the same team.
 */
export function anonymiseSubmissionId(submissionId: string, cohortSalt: string): string {
  const digest = createHash('sha256').update(`${cohortSalt}:${submissionId}`, 'utf8').digest('hex');
  return `SUB-${digest.slice(0, 12).toUpperCase()}`;
}

export function isAnonymisedId(value: string): boolean {
  return /^SUB-[0-9A-F]{12}$/.test(value);
}

// --------------------------------------------------------------------------
// Deterministic ids for fixtures
// --------------------------------------------------------------------------

/**
 * Stable uuid-shaped id derived from a name.
 *
 * Demo fixtures must be identical on every run — a demo where ids churn cannot
 * be linked to in documentation or asserted against in tests.
 */
export function deterministicId(namespace: string, name: string): string {
  const digest = createHash('sha256').update(`${namespace}/${name}`, 'utf8').digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}
