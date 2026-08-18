import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND } from '@ohj/shared/client';

/**
 * The palette, pinned to the design system.
 *
 * This portal is going to sit inside the main Outskill site, so "close enough"
 * is the failure: two oranges a few points apart read as a mistake in a way one
 * wrong orange never would. The values are therefore asserted literally against
 * `DESIGN-SYSTEM.md`, not merely against each other.
 *
 * The two accessibility rules in the document are the other thing worth
 * pinning, because both are invisible in dark mode and only bite in light:
 * orange as text must darken, and text on an orange fill must be the warm ink
 * rather than white.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const css = () => readFile(resolve(ROOT, 'apps/web/src/app/globals.css'), 'utf8');
const doc = () => readFile(resolve(ROOT, 'DESIGN-SYSTEM.md'), 'utf8');

/** The value of a custom property inside a given selector block. */
function tokenIn(source: string, selector: string, name: string): string | null {
  const start = source.indexOf(selector);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n}', open);
  const block = source.slice(open, close);
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1]!.trim().toLowerCase() : null;
}

const DARK = ':root {';
const LIGHT = ":root[data-theme='light']";

describe('the accent', () => {
  it('is the design system’s orange, everywhere it is defined', async () => {
    const source = await css();
    expect(tokenIn(source, DARK, '--accent')).toBe('#ff5e3a');
    expect(tokenIn(source, DARK, '--accent-hover')).toBe('#ff7a5e');
    expect(tokenIn(source, DARK, '--accent-pressed')).toBe('#e54a28');
    expect(BRAND.accent).toBe('#ff5e3a');
    expect(BRAND.accentHover).toBe('#ff7a5e');
  });

  it('is unchanged between themes, because the document says it is', async () => {
    const source = await css();
    // Only `--accent-text` moves. A light-mode override of `--accent` itself
    // would mean two brand colours.
    expect(tokenIn(source, LIGHT, '--accent')).toBeNull();
  });

  it('carries no trace of the lime it replaced', async () => {
    const source = await css();
    for (const dead of ['#c8ff38', '#b7ee2f', '#060806', '#10140e', '#161c13', '#1d2419', '#2a3326']) {
      expect(source, `the old palette survives: ${dead}`).not.toContain(dead);
    }
    expect(JSON.stringify(BRAND)).not.toContain('#c8ff38');
  });
});

describe('orange as text', () => {
  it('darkens in light mode, where raw accent fails AA', async () => {
    const source = await css();
    expect(tokenIn(source, DARK, '--accent-text')).toBe('#ff5e3a');
    expect(tokenIn(source, LIGHT, '--accent-text')).toBe('#c9391a');
  });

  it('is what `text-brand-text` resolves to, and `text-brand` no longer exists', async () => {
    const source = await css();
    expect(source).toContain('--color-brand-text: var(--accent-text)');
    // `--color-brand` remains, for fills and borders.
    expect(source).toContain('--color-brand: var(--accent)');
  });

  it('is used for every orange word in the interface', async () => {
    // A `text-brand` left anywhere would be raw accent on text — invisible now,
    // and a contrast failure the moment the host renders light.
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rIoE --exclude="*.test.*" "\\\\btext-brand([^-]|$)" ${resolve(ROOT, 'apps/web/src')} || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(hits, `text-brand should be text-brand-text:\n${hits}`).toBe('');
  });
});

describe('ink on an orange fill', () => {
  it('is the warm near-black, never white', async () => {
    const source = await css();
    expect(tokenIn(source, DARK, '--accent-ink')).toBe('#1a0a00');
    expect(BRAND.accentInk).toBe('#1a0a00');
    expect(source).toContain('--color-on-accent: var(--accent-ink)');
  });

  it('has replaced every plain black label on an accent fill', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rIo --exclude="*.test.*" "text-black" ${resolve(ROOT, 'apps/web/src')} || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(hits, `plain black on an accent fill:\n${hits}`).toBe('');
  });

  it('is what the primary button uses', async () => {
    const button = await readFile(resolve(ROOT, 'apps/web/src/components/ui/index.tsx'), 'utf8');
    expect(button).toContain('bg-brand text-on-accent');
    expect(button).not.toMatch(/bg-brand[^'"]*text-white/);
  });
});

describe('semantic colours keep their meanings', () => {
  it('success is green, not orange', async () => {
    const source = await css();
    expect(tokenIn(source, DARK, '--success')).toBe('#4ade80');
    expect(tokenIn(source, LIGHT, '--success')).toBe('#15803d');
    // The point of the whole migration rule: a mechanical find-and-replace of
    // the old green would have made success orange, and success is not a brand.
    expect(tokenIn(source, DARK, '--success')).not.toBe(tokenIn(source, DARK, '--accent'));
  });

  it('danger is red and info is blue', async () => {
    const source = await css();
    expect(tokenIn(source, DARK, '--danger')).toBe('#f87171');
    expect(tokenIn(source, LIGHT, '--danger')).toBe('#dc2626');
    expect(tokenIn(source, DARK, '--info')).toBe('#60a5fa');
    expect(tokenIn(source, LIGHT, '--info')).toBe('#2563eb');
  });

  it('keeps a warning that is neither danger nor accent', async () => {
    // The design system has no warning token and this product needs one:
    // "two things missing" is not an error. Documented where it is defined.
    const source = await css();
    const warning = tokenIn(source, DARK, '--warning');
    expect(warning).toBeTruthy();
    expect(warning).not.toBe(tokenIn(source, DARK, '--danger'));
    expect(warning).not.toBe(tokenIn(source, DARK, '--accent'));
    expect(source).toContain('Warning has no token in the design system');
  });
});

describe('the token values match the document they came from', () => {
  it('every neutral is quoted from DESIGN-SYSTEM.md', async () => {
    const source = await css();
    const document = (await doc()).toLowerCase();

    for (const [name, value] of [
      ['--bg', '#0a0a0b'],
      ['--bg-elevated', '#111114'],
      ['--bg-card', '#141418'],
      ['--bg-inset', '#0c0c0e'],
      ['--border-subtle', '#1c1c20'],
      ['--border', '#26262c'],
      ['--border-strong', '#3a3a42'],
      ['--text', '#fafafa'],
      ['--text-secondary', '#a1a1a8'],
      ['--text-muted', '#83838d'],
      ['--text-dim', '#56565f'],
    ] as const) {
      expect(tokenIn(source, DARK, name), name).toBe(value);
      expect(document, `${value} is not in the design system`).toContain(value);
    }
  });

  it('defines a light theme without shipping a toggle', async () => {
    const source = await css();
    expect(source).toContain(LIGHT);
    expect(tokenIn(source, LIGHT, '--bg')).toBe('#fafafa');
    expect(tokenIn(source, LIGHT, '--text')).toBe('#18181b');

    // The host site applies `data-theme`. Adding a switcher was explicitly out
    // of scope, so there must not be one.
    const { execSync } = await import('node:child_process');
    const toggles = execSync(
      `grep -rIl --exclude="*.test.*" "localStorage.getItem('theme')\\|setAttribute('data-theme'" ${resolve(ROOT, 'apps/web/src')} || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(toggles, 'a theme toggle was added').toBe('');
  });
});

describe('what the migration must not have changed', () => {
  it('leaves the radius and spacing scales alone', async () => {
    const source = await css();
    expect(source).toContain('--radius-card: 14px');
    expect(source).toContain('--radius-control: 10px');
  });

  it('leaves the font stacks alone', async () => {
    const source = await css();
    // The document specifies Geist and Instrument Serif. Typography was
    // explicitly out of scope, so the original system stack stays.
    expect(source).toContain('--font-sans: ui-sans-serif, system-ui');
    expect(source).not.toContain('Instrument Serif');
    expect(source).not.toContain('Geist');
  });

  it('adds no aurora background, because there was none to recolour', async () => {
    const source = await css();
    for (const added of ['aurora', 'glow-1', 'glow-2', '--grid-line']) {
      expect(source, `an unrequested treatment was added: ${added}`).not.toContain(added);
    }
    // The glow that already existed keeps its structure and takes the new colour.
    expect(source).toContain('.glow-accent');
    expect(source).toContain('var(--accent-glow)');
  });

  it('keeps focus visible, in the accent', async () => {
    const source = await css();
    expect(source).toMatch(/focus-visible\)?\s*\{[\s\S]*?outline: 2px solid var\(--accent\)/);
  });
});
