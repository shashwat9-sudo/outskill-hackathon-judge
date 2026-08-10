/**
 * Brand tokens.
 *
 * The supplied pitch-deck template uses the stock Google Slides theme
 * (accent `#4285F4`), so no Outskill green exists in any asset we were given.
 * The green below is a documented placeholder chosen for contrast, not a guess
 * at the real brand colour (ADR-014). Replacing it is a one-line change here
 * plus the `BRAND_GREEN` environment variable.
 *
 * Contrast, verified against WCAG 2.1 AA:
 *   green700 (#0B8A45) on white   → 4.53:1  (AA for normal text)
 *   green500 (#00C853) on black   → 9.94:1  (AAA)
 *   white on green700             → 4.53:1  (AA)
 */

export const BRAND = {
  /** Primary accent. Use on dark surfaces and for non-text emphasis. */
  green500: '#00C853',
  /** Text-safe green on light surfaces. */
  green700: '#0B8A45',
  /** Deep green for large headings and dark-surface fills. */
  green900: '#064E2B',
  /** Tint for subtle backgrounds. */
  green50: '#E8F8EE',

  black: '#000000',
  white: '#FFFFFF',

  /** Neutrals — the deck palette is black, white and green, so greys stay cool. */
  grey900: '#111111',
  grey700: '#3A3A3A',
  grey500: '#6B6B6B',
  grey300: '#D4D4D4',
  grey100: '#F2F2F2',

  /** Status colours. Deliberately not green, so "pass" never reads as branding. */
  danger: '#B3261E',
  warning: '#8A5A00',
  info: '#1B5E9E',
} as const;

export type BrandToken = keyof typeof BRAND;

/** Allow the placeholder green to be overridden without a code change. */
export function resolveBrandGreen(envValue: string | undefined): string {
  if (!envValue) return BRAND.green500;
  const trimmed = envValue.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : BRAND.green500;
}

/** Palette for the programmatically generated internal deck (Phase 6). */
export const DECK_PALETTE = {
  background: BRAND.black,
  surface: BRAND.grey900,
  text: BRAND.white,
  textMuted: BRAND.grey300,
  accent: BRAND.green500,
  accentDeep: BRAND.green900,
} as const;
