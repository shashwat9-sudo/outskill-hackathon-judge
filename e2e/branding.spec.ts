import { expect, test } from '@playwright/test';

/**
 * Outskill visual system.
 *
 * These assert the theme is actually applied rather than merely defined — a
 * token file that nothing consumes looks identical to a broken build in a
 * screenshot review.
 */

test.describe('Outskill dark theme', () => {
  test('applies the dark design-system tokens on the root page', async ({ page }) => {
    await page.goto('/');

    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string) => style.getPropertyValue(name).trim().toLowerCase();
      return {
        background: read('--bg'),
        accent: read('--accent'),
        accentText: read('--accent-text'),
        text: read('--text'),
        surface: read('--bg-card'),
        border: read('--border'),
      };
    });

    expect(tokens.background).toBe('#0a0a0b');
    expect(tokens.accent).toBe('#ff5e3a');
    expect(tokens.accentText).toBe('#ff5e3a');
    expect(tokens.text).toBe('#fafafa');
    expect(tokens.surface).toBe('#141418');
    expect(tokens.border).toBe('#26262c');
  });

  test('paints a near-black page rather than a white admin tool', async ({ page }) => {
    await page.goto('/');
    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // #0A0A0B
    expect(bodyBackground).toBe('rgb(10, 10, 11)');
  });

  test('keeps the dark theme on the learner portal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Open learner portal' }).first().click();

    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBackground).toBe('rgb(10, 10, 11)');
  });

  test('uses the accent on the primary call to action, with warm ink', async ({ page }) => {
    await page.goto('/');
    const cta = page.getByRole('link', { name: /Preview learner journey/ });
    await expect(cta).toBeVisible();

    const styles = await cta.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, color: computed.color };
    });

    expect(styles.background).toBe('rgb(255, 94, 58)'); // #FF5E3A
    // #1A0A00, never white and never plain black: the design system's rule for
    // anything sitting on an orange fill.
    expect(styles.color).toBe('rgb(26, 10, 0)');
  });

  test('serves a light theme when the host asks for one', async ({ page }) => {
    // No toggle ships here. The main Outskill site sets `data-theme`, and this
    // proves the tokens respond when it does.
    await page.goto('/');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    const light = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        bg: style.getPropertyValue('--bg').trim().toLowerCase(),
        text: style.getPropertyValue('--text').trim().toLowerCase(),
        // Orange as text darkens, or it fails AA on white.
        accentText: style.getPropertyValue('--accent-text').trim().toLowerCase(),
        accent: style.getPropertyValue('--accent').trim().toLowerCase(),
      };
    });

    expect(light.bg).toBe('#fafafa');
    expect(light.text).toBe('#18181b');
    expect(light.accentText).toBe('#c9391a');
    // The brand colour itself does not move between themes.
    expect(light.accent).toBe('#ff5e3a');
  });

  test('keeps no trace of the lime it replaced', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    for (const dead of ['#c8ff38', '#b7ee2f', '200, 255, 56', '#060806', '#10140e']) {
      expect(html, `the old palette survives: ${dead}`).not.toContain(dead);
    }
  });

  test('does not use default Tailwind blue for ordinary UI', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    // The stock palette classes that would signal a generic SaaS dashboard.
    for (const cls of ['bg-blue-500', 'bg-blue-600', 'text-blue-500', 'text-blue-600', 'bg-indigo-']) {
      expect(html, `found default Tailwind class "${cls}"`).not.toContain(cls);
    }
  });
});
