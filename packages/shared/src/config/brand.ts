/**
 * Brand tokens — the single source of truth for anything that is not CSS.
 *
 * These mirror `DESIGN-SYSTEM.md` and the dark-theme block in
 * `apps/web/src/app/globals.css`. The web interface reads the CSS variables,
 * never this object; this exists for the places that cannot — generated PDFs,
 * documentation, and scripts.
 *
 * Two copies is one more than ideal. They are kept honest by
 * `brand-tokens.test.ts`, which reads the stylesheet and compares.
 */

export const BRAND = {
  /** The brand colour. Warm orange, identical in both themes. */
  accent: '#ff5e3a',
  accentHover: '#ff7a5e',
  accentPressed: '#e54a28',
  /**
   * Orange used AS TEXT.
   *
   * The same value in dark mode and a darker one in light, where raw accent on
   * white is 3.2:1 and fails AA. Never use `accent` for text.
   */
  accentText: '#ff5e3a',
  accentTextLight: '#c9391a',
  /** Ink on an orange fill. Never white: 6.4:1 against the accent. */
  accentInk: '#1a0a00',

  /** Near-black page, with three raised planes above it. */
  background: '#0a0a0b',
  surface: '#141418',
  surfaceRaised: '#111114',
  surfaceSoft: '#0c0c0e',

  text: '#fafafa',
  textMuted: '#a1a1a8',
  border: '#26262c',

  danger: '#f87171',
  /** No design-system token; see the note in globals.css. */
  warning: '#f3bd52',
  success: '#4ade80',

  /** Reserved for links and technical information only. Never a primary action. */
  link: '#60a5fa',

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
