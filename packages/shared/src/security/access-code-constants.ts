/**
 * Access-code constants, separated from the code that uses them.
 *
 * The entry form needs the expected length and the failure message, and it is a
 * client component. `access-code.ts` imports `node:crypto` and Argon2, so it
 * cannot enter a browser bundle — importing it for a number would drag credential
 * handling into client JavaScript.
 *
 * This file has no imports at all, which is what makes it safe to re-export from
 * `@ohj/shared/client`.
 */

/**
 * Crockford-style alphabet with the characters people misread removed:
 * no O/0, no I/1/L, no U (to avoid accidental words).
 */
export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** 12 characters, displayed in three groups of four. */
export const ACCESS_CODE_LENGTH = 12;
export const ACCESS_CODE_GROUP_SIZE = 4;

/**
 * The single failure message.
 *
 * Deliberately identical for an unknown group, a wrong code, a revoked code and
 * a closed cohort, so the form cannot be used to enumerate which group numbers
 * exist.
 */
export const GENERIC_VERIFICATION_ERROR =
  'We could not verify those team access details. Check the group number and access code, then try again.';
