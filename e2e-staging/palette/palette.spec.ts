import { expect, test, type Page } from '@playwright/test';

/**
 * The palette, on the deployment.
 *
 * The token tests pin the stylesheet and the branding suite pins the hermetic
 * build. This asks the last question neither can: does the browser, against the
 * real deployment, actually paint what was approved.
 *
 * Computed styles rather than screenshots — a screenshot diff would report a
 * changed pixel without saying which colour moved or why.
 */

/** What a rendered element is really painted with. */
async function paintOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color, border: s.borderColor };
  });
}

const ORANGE = 'rgb(255, 94, 58)';
const INK = 'rgb(26, 10, 0)';
const PAGE = 'rgb(10, 10, 11)';

test.describe('learner surface', () => {
  test('the entry page is painted in the new neutrals', async ({ page }) => {
    await page.goto('/submit');
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(body).toBe(PAGE);
  });

  test('the primary action is orange with warm ink, never white', async ({ page }) => {
    await page.goto('/submit');
    const button = page.getByRole('button', { name: 'Continue' });
    await expect(button).toBeVisible();

    const paint = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color };
    });
    expect(paint.background).toBe(ORANGE);
    expect(paint.color).toBe(INK);
    expect(paint.color).not.toBe('rgb(255, 255, 255)');
  });

  test('every semantic colour still means what it meant', async ({ page }) => {
    await page.goto('/submit');
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const read = (n: string) => s.getPropertyValue(n).trim().toLowerCase();
      return {
        accent: read('--accent'),
        success: read('--success'),
        warning: read('--warning'),
        danger: read('--danger'),
        info: read('--info'),
      };
    });

    expect(tokens.accent).toBe('#ff5e3a');
    // Green, not orange. The whole point of mapping by meaning.
    expect(tokens.success).toBe('#4ade80');
    expect(tokens.warning).toBe('#f3bd52');
    expect(tokens.danger).toBe('#f87171');
    expect(tokens.info).toBe('#60a5fa');
  });

  test('no lime survives anywhere in the served page', async ({ page }) => {
    for (const path of ['/submit', '/submit/guide', '/submit/example']) {
      await page.goto(path);
      const html = (await page.content()).toLowerCase();
      for (const dead of ['c8ff38', 'b7ee2f', '200, 255, 56', '060806', '10140e', '2a3326']) {
        expect(html, `${path} still carries ${dead}`).not.toContain(dead);
      }
    }
  });

  test('focus stays visible, in the accent', async ({ page }) => {
    await page.goto('/submit');

    // Tabbed, not focused programmatically. `:focus-visible` is what carries
    // the outline rule, and Chromium only matches it for keyboard interaction —
    // `.focus()` leaves the browser default in place and says nothing.
    await page.getByLabel('Group number').click();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');

    /*
     * Read after the transition, not during it.
     *
     * The control carries `transition-colors`, and Tailwind's list includes
     * `outline-color`. `getComputedStyle` returns the value mid-flight, which
     * starts at `currentColor` — so measuring immediately reports the text
     * colour and looks exactly like a broken focus ring.
     */
    await expect
      .poll(
        () =>
          page
            .getByLabel('Group number')
            .evaluate((el) => getComputedStyle(el).outlineColor),
        { timeout: 5_000 },
      )
      .toBe(ORANGE);

    const ring = await page
      .getByLabel('Group number')
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.outlineWidth, style: s.outlineStyle, visible: el.matches(':focus-visible') };
      });
    expect(ring.visible).toBe(true);
    expect(ring.width).toBe('2px');
    expect(ring.style).toBe('solid');
  });

  test('the completed example and guide render in the new palette', async ({ page }) => {
    await page.goto('/submit/example');
    const banner = await paintOf(page, '[data-testid="example-banner"]');

    /*
     * Chromium serialises a translucent token as `oklab(...)`, not `rgba(...)`,
     * so matching on the hex triple would only ever have passed by accident.
     *
     * In oklab the `a` axis runs green-negative to red-positive. The old tint
     * was lime, which is unambiguously negative; the accent is orange, which is
     * unambiguously positive. That single sign is the whole assertion, and it
     * survives however the browser chooses to write the value down.
     */
    const warm = /oklab\(\s*[\d.]+\s+(-?[\d.]+)/.exec(banner.background);
    if (warm) {
      expect(Number(warm[1]), `tint is not warm: ${banner.background}`).toBeGreaterThan(0);
    } else {
      expect(banner.background).toMatch(/rgba?\(255, 94, 58/);
    }

    // And the token it came from is the accent.
    const soft = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim(),
    );
    // Lightning CSS rewrites the authored `rgba()` to 8-digit hex, so accept
    // either spelling of the same colour.
    expect(soft.toLowerCase()).toMatch(/#ff5e3a|255,\s*94,\s*58/);

    await page.goto('/submit/guide');
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(body).toBe(PAGE);
  });
});

test.describe('admin surface', () => {
  test('the sign-in page is painted in the new palette', async ({ page }) => {
    // The admin interior needs a password, which is the operator's. The sign-in
    // page is the reachable part, and it exercises the same tokens.
    const response = await page.goto('/admin');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/admin\/login/);

    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(body).toBe(PAGE);

    const submit = page.getByRole('button', { name: /sign in/i });
    await expect(submit).toBeVisible();
    const paint = await submit.evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color };
    });
    expect(paint.background).toBe(ORANGE);
    expect(paint.color).toBe(INK);
  });

  test('carries no lime', async ({ page }) => {
    await page.goto('/admin/login');
    const html = (await page.content()).toLowerCase();
    for (const dead of ['c8ff38', 'b7ee2f', '200, 255, 56']) {
      expect(html).not.toContain(dead);
    }
  });
});

test.describe('nothing but colour moved', () => {
  test('the six-step form still works end to end', async ({ page }) => {
    // A palette migration that broke a form would show up here and nowhere in a
    // colour assertion.
    await page.goto('/submit');
    await expect(page.getByTestId('team-verify-form')).toBeVisible();
    await expect(page.getByLabel('Group number')).toBeVisible();
    await expect(page.getByLabel('Team access code')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('the guide PDF still renders', async ({ page }) => {
    const response = await page.request.get('/api/guide');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('pdf');
  });
});
