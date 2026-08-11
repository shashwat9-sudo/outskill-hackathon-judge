/**
 * Brand tokens — the single source of truth.
 *
 * The exact Outskill green has NOT been confirmed. `accent` and `accentHover`
 * below are documented placeholders (ADR-014). Replacing them, plus the two
 * matching CSS variables in `apps/web/src/app/globals.css`, changes the whole
 * product — nothing else hard-codes a colour.
 *
 * See docs/BRANDING.md for the full token reference and the swap procedure.
 */

export const BRAND = {
  /** Placeholder accent — bright lime. Swap for the official green. */
  accent: '#c8ff38',
  accentHover: '#b7ee2f',

  /** Near-black page, charcoal and dark-green raised planes. */
  background: '#060806',
  surface: '#10140e',
  surfaceRaised: '#161c13',
  surfaceSoft: '#1d2419',

  text: '#f4f7f1',
  textMuted: '#9fa89a',
  border: '#2a3326',

  danger: '#ff6262',
  warning: '#f3bd52',
  success: '#77dd77',

  /** Reserved for links and technical information only. Never a primary action. */
  link: '#7fc4ff',

  black: '#000000',
  white: '#ffffff',
} as const;

export type BrandToken = keyof typeof BRAND;

/** Allow the placeholder accent to be overridden without a code change. */
export function resolveBrandAccent(envValue: string | undefined): string {
  if (!envValue) return BRAND.accent;
  const trimmed = envValue.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : BRAND.accent;
}

/** Palette for the programmatically generated internal deck. */
export const DECK_PALETTE = {
  background: BRAND.background,
  surface: BRAND.surface,
  text: BRAND.text,
  textMuted: BRAND.textMuted,
  accent: BRAND.accent,
  accentDeep: BRAND.surfaceSoft,
} as const;

/**
 * Spacing scale (8px base) and radii, mirrored in CSS.
 * Kept here so generated artefacts (deck, exports) stay consistent with the app.
 */
export const SPACING = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96] as const;
export const RADIUS = { control: 10, card: 14 } as const;
