import { expect, test } from '@playwright/test';

/**
 * Outskill visual system.
 *
 * These assert the theme is actually applied rather than merely defined — a
 * token file that nothing consumes looks identical to a broken build in a
 * screenshot review.
 */

test.describe('Outskill dark theme', () => {
  test('applies the dark brand tokens on the root page', async ({ page }) => {
    await page.goto('/');

    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue('--brand-background').trim(),
        accent: style.getPropertyValue('--brand-accent').trim(),
        text: style.getPropertyValue('--brand-text').trim(),
        surface: style.getPropertyValue('--brand-surface').trim(),
        border: style.getPropertyValue('--brand-border').trim(),
      };
    });

    expect(tokens.background).toBe('#060806');
    expect(tokens.accent).toBe('#c8ff38');
    expect(tokens.text).toBe('#f4f7f1');
    expect(tokens.surface).toBe('#10140e');
    expect(tokens.border).toBe('#2a3326');
  });

  test('paints a near-black page rather than a white admin tool', async ({ page }) => {
    await page.goto('/');
    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // #060806
    expect(bodyBackground).toBe('rgb(6, 8, 6)');
  });

  test('keeps the dark theme on the learner portal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Open learner portal' }).first().click();

    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBackground).toBe('rgb(6, 8, 6)');
  });

  test('uses the lime accent on the primary call to action, with black text', async ({ page }) => {
    await page.goto('/');
    const cta = page.getByRole('link', { name: /Preview learner journey/ });
    await expect(cta).toBeVisible();

    const styles = await cta.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, color: computed.color };
    });

    expect(styles.background).toBe('rgb(200, 255, 56)'); // #c8ff38
    expect(styles.color).toBe('rgb(0, 0, 0)');
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
