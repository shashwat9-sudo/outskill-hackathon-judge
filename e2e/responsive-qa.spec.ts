import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { dismissTour, openScenario, portalHref } from './learner-support';

/**
 * Responsive QA across the learner journey.
 *
 * Not a design review by eye. Every width drives the same surfaces and measures
 * the things that actually go wrong when a layout is only ever checked at one
 * size: the page scrolling sideways, a control off the edge, a line of prose
 * running to 140 characters because a column grew, a form marooned in the
 * middle of a wide screen.
 *
 * Screenshots land in `test-results/responsive-qa/` for the parts a measurement
 * cannot judge. The numbers are written beside them as JSON so a regression is
 * a diff rather than a memory.
 *
 * Hermetic demo server, fixture data. Nothing here touches a real cohort.
 */

const OUT = 'test-results/responsive-qa';

const WIDTHS = [
  { name: 'phone', width: 360, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
] as const;

/**
 * The comfortable reading measure.
 *
 * Typographic convention is 45–75 characters a line. At the body size used here
 * (16px, ~8.2px average advance) 75 characters is about 620px, and prose keeps
 * reading well to around 90. Past that a reader loses the start of the next
 * line, which on a form means re-reading the question.
 */
const MAX_PROSE_PX = 760;

/** Below this a control is not comfortably tappable. */
const MIN_TOUCH_PX = 40;

interface Measurement {
  surface: string;
  overflowX: number;
  offscreenControls: string[];
  /** Every text line wider than the comfortable measure, worst first. */
  wideProse: { px: number; text: string }[];
  /** The widest single form control — where a column's real width shows. */
  widestControl: { px: number; id: string } | null;
  smallTargets: string[];
  /** Fraction of the viewport left empty either side of the content column. */
  emptyGutterRatio: number;
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

/**
 * Measure one rendered surface.
 *
 * Prose width is taken from text-bearing leaf elements only. A `<div>` wrapping
 * a paragraph is as wide as its container by definition and says nothing about
 * whether the line is readable; the element that holds the words does.
 */
async function measure(page: Page, surface: string): Promise<Measurement> {
  return page.evaluate(
    ({ maxProse, minTouch, surfaceName }) => {
      const de = document.documentElement;
      const viewport = de.clientWidth;

      const offscreenControls: string[] = [];
      const smallTargets: string[] = [];
      const wideProse: { px: number; text: string }[] = [];
      let widestControl: { px: number; id: string } | null = null;

      const describe = (el: Element) => {
        const e = el as HTMLElement;
        const label = (e.getAttribute('data-testid') || e.id || e.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 45);
        return `${e.tagName.toLowerCase()}${label ? `[${label}]` : ''}`;
      };

      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      /**
       * Parked off-canvas on purpose.
       *
       * The skip link lives at `left: -9999px` until it takes focus, which is
       * the standard way to offer it. Reporting it as a control off the edge of
       * the screen would bury every real finding under the same false one.
       */
      const parkedByDesign = (el: Element) => {
        if (el.classList.contains('skip-link') || el.classList.contains('sr-only')) return true;
        const style = getComputedStyle(el);
        return style.position === 'absolute' && parseFloat(style.left || '0') < -1000;
      };

      for (const el of document.querySelectorAll('button, a, input, textarea, select, [role="button"]')) {
        if (!visible(el) || parkedByDesign(el)) continue;
        const r = el.getBoundingClientRect();
        // `sr-only` controls are 1px by design and are not tap targets.
        if (r.width <= 2 && r.height <= 2) continue;
        if (r.left < -1 || r.right > viewport + 1) offscreenControls.push(describe(el));
        if (r.height < minTouch && el.tagName !== 'A') smallTargets.push(describe(el));

        if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox' && (el as HTMLInputElement).type !== 'radio')) {
          if (!widestControl || r.width > widestControl.px) {
            widestControl = { px: Math.round(r.width), id: (el as HTMLElement).id || describe(el) };
          }
        }
      }

      for (const el of document.querySelectorAll('p, li, label, h1, h2, h3')) {
        if (!visible(el)) continue;
        // Leaves only: a container's width is not a line length.
        const ownText = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim();
        if (ownText.length < 60) continue;

        const r = el.getBoundingClientRect();
        // Only a line that actually reaches the edge is too long; a short
        // sentence in a wide box wraps nowhere and reads fine.
        if (r.width > maxProse && r.height > 0) {
          wideProse.push({ px: Math.round(r.width), text: ownText.slice(0, 60) });
        }
      }
      wideProse.sort((a, b) => b.px - a.px);

      // How much of the viewport the content actually occupies. A narrow column
      // marooned in a wide window shows up here and nowhere else.
      const main = document.querySelector('main');
      const contentWidth = main ? main.getBoundingClientRect().width : viewport;
      const emptyGutterRatio = Math.max(0, 1 - contentWidth / viewport);

      return {
        surface: surfaceName,
        overflowX: de.scrollWidth - de.clientWidth,
        offscreenControls: [...new Set(offscreenControls)].slice(0, 8),
        wideProse: wideProse.slice(0, 6),
        widestControl,
        smallTargets: [...new Set(smallTargets)].slice(0, 8),
        emptyGutterRatio: Number(emptyGutterRatio.toFixed(2)),
      };
    },
    { maxProse: MAX_PROSE_PX, minTouch: MIN_TOUCH_PX, surfaceName: surface },
  );
}

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

/** Steps are folded behind a toggle on the narrowest screens only. */
async function goToStep(page: Page, index: number) {
  const toggle = page.getByTestId('toggle-steps');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.getByTestId('submission-stepper').first().getByRole('button').nth(index).click();
}

for (const { name, width, height } of WIDTHS) {
  test.describe(`${name} (${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test(`the whole learner journey holds together at ${width}px`, async ({ page }) => {
      const taken: Measurement[] = [];
      const record = async (surface: string, screenshot?: string) => {
        const m = await measure(page, surface);
        taken.push(m);
        if (screenshot) await shoot(page, `${name}-${screenshot}`);
        return m;
      };

      // --- The first-run walkthrough ---
      await page.context().clearCookies({ name: 'ohj_team_session' });
      await page.goto(await portalHref(page, 'incomplete'));
      await page.getByLabel('Your name').fill('QA visitor');
      await page.getByRole('button', { name: 'Open our submission' }).click();
      await expect(page.getByTestId('submission-walkthrough')).toBeVisible();
      await record('walkthrough', '01-walkthrough');

      // Mid-tour, where the panel holds its longest sentence.
      await page.getByTestId('tour-next').click();
      await page.getByTestId('tour-next').click();
      await page.getByTestId('tour-next').click();
      await record('walkthrough-mid');
      await dismissTour(page);

      // --- Step 1: team, with its side-by-side fields ---
      await expect(page.getByTestId('percent-complete')).toBeVisible();
      await record('step-team', '02-step-team');

      // --- Step 2: product idea — cards, then a question explaining itself ---
      await goToStep(page, 1);
      await expect(page.getByTestId('idea-cards')).toBeVisible();
      await record('step-product', '03-step-product');

      await page.getByTestId('see-example-exactProblem').click();
      await expect(page.getByTestId('example-exactProblem')).toBeVisible();
      await record('field-example', '04-field-example');

      // --- What's missing ---
      await page
        .getByTestId('missing-panel-product')
        .getByRole('button', { name: /What’s missing\?/ })
        .click();
      await record('whats-missing', '05-whats-missing');

      // --- A long answer, which is where a column's real width shows ---
      await page.locator('#briefDescription').fill('word '.repeat(160).trim());
      await record('long-answer', '06-long-answer');

      // --- Step 3: live product, with its repeated test steps ---
      await goToStep(page, 2);
      await record('step-live', '07-step-live');

      // --- Step 4: deck upload ---
      await goToStep(page, 3);
      await expect(page.getByText('Upload your pitch deck (PDF)')).toBeVisible();
      await record('step-artifacts', '08-step-artifacts');

      // --- Step 5: learning evidence, the densest step ---
      await goToStep(page, 4);
      await record('step-learning', '09-step-learning');

      // --- Review, declarations and Final Submit ---
      await goToStep(page, 5);
      await expect(page.getByTestId('review-checklist')).toBeVisible();
      await record('review', '10-review');

      // --- The help menu ---
      await page.getByTestId('need-help').click();
      await expect(page.getByTestId('help-menu')).toBeVisible();
      await record('help-menu', '11-help-menu');
      await page.getByRole('button', { name: 'How to fill this step' }).click();
      await record('help-step-panel');
      await page.getByTestId('close-help').click();

      // --- The completed example ---
      await page.goto('/submit/example');
      await expect(page.getByTestId('example-banner')).toBeVisible();
      await record('completed-example', '12-completed-example');

      // --- The written guide ---
      await page.goto('/submit/guide');
      await expect(page.getByRole('heading', { name: 'The six steps' })).toBeVisible();
      await record('guide', '13-guide');

      // --- The receipt, the last thing a team sees ---
      await openScenario(page, 'complete');
      await expect(page.getByTestId('submission-receipt')).toBeVisible();
      await record('receipt', '14-receipt');

      // Written per width, so a failure still leaves the numbers behind.
      await writeFile(`${OUT}/measure-${name}.json`, JSON.stringify(taken, null, 2));

      // ---- Assertions, applied to every surface ----
      for (const m of taken) {
        expect(m.overflowX, `${name}/${m.surface} scrolls sideways`).toBeLessThanOrEqual(1);
        expect(m.offscreenControls, `${name}/${m.surface} has controls off-screen`).toEqual([]);
        expect(
          m.wideProse,
          `${name}/${m.surface} has over-wide lines: ${JSON.stringify(m.wideProse)}`,
        ).toEqual([]);
        expect(
          m.widestControl?.px ?? 0,
          `${name}/${m.surface} has a ${m.widestControl?.px}px control (${m.widestControl?.id})`,
        ).toBeLessThanOrEqual(MAX_PROSE_PX);
      }
    });
  });
}
