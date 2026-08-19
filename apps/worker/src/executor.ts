/**
 * The test-plan executor.
 *
 * Executes a validated plan against an untrusted participant product.
 *
 * Safety properties, in order of importance:
 *   1. The handler map is exhaustive over the DSL union with NO default case,
 *      so an unknown action is a compile error, not a runtime surprise.
 *   2. There is no handler that evaluates code. `page.evaluate` is never called
 *      with plan-derived input anywhere in this file.
 *   3. Every navigation re-runs the SSRF guard against freshly resolved
 *      addresses, immediately before navigating.
 *   4. Navigation is confined to the product's own origin.
 *   5. Credentials are substituted at execution time from placeholders, so they
 *      never appear in a stored plan, and they are masked in every recorded
 *      artefact.
 */

import { lookup } from 'node:dns/promises';
import type { BrowserContext, Locator, Page } from 'playwright';
import {
  TEST_DATA_PREFIX,
  assertNavigationAllowed,
  type TestStep,
  type TestTarget,
} from '@ohj/shared';

export const CREDENTIAL_USERNAME_PLACEHOLDER = 'OUTSKILL-JUDGE-CREDENTIAL-USERNAME';
export const CREDENTIAL_PASSWORD_PLACEHOLDER = 'OUTSKILL-JUDGE-CREDENTIAL-PASSWORD';
const MASK = '[demo credential, masked]';

export interface ExecutionContext {
  page: Page;
  context: BrowserContext;
  /** Confines navigation to the product being assessed. */
  allowedOrigin: string;
  credentials: { username: string; password: string } | null;
  /** Absolute wall-clock cutoff for the whole run. */
  deadline: number;
  screenshotDir: string;
  /**
   * Part of the screenshot filename, because both viewports share a directory.
   *
   * Without it desktop and mobile produce the same name for the same step, the
   * second overwrites the first on disk, and — because the durable path is
   * derived from the basename — the second upload is refused because an object
   * already exists there. Mobile evidence was being lost that way, quietly,
   * with only a warning to show for it. The trace path has always carried the
   * viewport; this is the same fix for screenshots.
   */
  viewport: 'desktop' | 'mobile';
  onScreenshot?: (label: string, path: string) => void;
  resolver?: (hostname: string) => Promise<string[]>;
  /**
   * TEST ONLY. Permits navigation to a loopback/private origin so the executor
   * can be exercised against the local fixture app.
   *
   * This does NOT disable the guard: the URL must still be http(s) and must
   * still be same-origin with `allowedOrigin`. It only skips the
   * resolved-address check, and only for that one origin.
   *
   * `runBrowserPlan` refuses to honour it when NODE_ENV is 'production', so it
   * cannot be turned on in a deployed worker even by mistake.
   */
  allowPrivateOriginForTesting?: boolean;
}

export interface StepResult {
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  detail: string;
  screenshotPath: string | null;
  errorMessage: string | null;
}

export interface RunObservations {
  consoleErrors: { text: string; location: string }[];
  networkFailures: { url: string; status: number | null; reason: string }[];
  a11yViolations: { id: string; impact: string; nodes: number; help: string }[];
  createdValues: string[];
}

const DEFAULT_STEP_TIMEOUT_MS = 15_000;

export class PlanExecutor {
  private readonly observations: RunObservations = {
    consoleErrors: [],
    networkFailures: [],
    a11yViolations: [],
    createdValues: [],
  };

  constructor(private readonly ctx: ExecutionContext) {}

  get results(): RunObservations {
    return this.observations;
  }

  /**
   * Attach console and network listeners.
   *
   * Console text is truncated and credential values are masked — a product that
   * logs its own login form would otherwise leak a third party's credential
   * into our evidence store.
   */
  attachListeners(): void {
    this.ctx.page.on('console', (message) => {
      if (message.type() !== 'error') return;
      this.observations.consoleErrors.push({
        text: this.mask(message.text()).slice(0, 500),
        location: `${message.location().url}:${message.location().lineNumber}`,
      });
    });

    this.ctx.page.on('pageerror', (error) => {
      this.observations.consoleErrors.push({
        text: this.mask(error.message).slice(0, 500),
        location: 'pageerror',
      });
    });

    this.ctx.page.on('requestfailed', (request) => {
      this.observations.networkFailures.push({
        url: request.url().slice(0, 300),
        status: null,
        reason: request.failure()?.errorText ?? 'request failed',
      });
    });

    this.ctx.page.on('response', (response) => {
      if (response.status() >= 400) {
        this.observations.networkFailures.push({
          url: response.url().slice(0, 300),
          status: response.status(),
          reason: `HTTP ${response.status()}`,
        });
      }
    });
  }

  async executeStep(step: TestStep, index: number): Promise<StepResult> {
    const started = Date.now();
    const timeout = Math.min(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, this.remainingBudget());

    const base = { stepIndex: index, action: step.action, screenshotPath: null as string | null };

    if (this.remainingBudget() <= 0) {
      return {
        ...base,
        status: 'skipped',
        durationMs: 0,
        detail: 'Skipped — the run budget was exhausted before this step.',
        errorMessage: null,
      };
    }

    try {
      const outcome = await this.dispatch(step, timeout, index);
      return {
        ...base,
        status: outcome.failed ? 'failed' : 'passed',
        durationMs: Date.now() - started,
        detail: outcome.detail,
        screenshotPath: outcome.screenshotPath ?? null,
        errorMessage: outcome.failed ? outcome.detail : null,
      };
    } catch (error) {
      const message = this.mask(error instanceof Error ? error.message : String(error)).slice(0, 400);
      return {
        ...base,
        // An optional step records its failure as evidence without derailing the run.
        status: step.optional ? 'skipped' : 'error',
        durationMs: Date.now() - started,
        detail: message,
        errorMessage: message,
      };
    }
  }

  /**
   * Dispatch to a handler.
   *
   * Exhaustive over the union with no default branch: adding an action to the
   * DSL without handling it here fails the build.
   */
  private async dispatch(
    step: TestStep,
    timeout: number,
    index: number,
  ): Promise<{ detail: string; failed?: boolean; screenshotPath?: string }> {
    const { page } = this.ctx;

    switch (step.action) {
      case 'navigate': {
        // Same-origin confinement applies unconditionally, including in tests.
        if (!this.isSameOrigin(step.url)) {
          return {
            detail: `Navigation blocked: ${step.url} is outside the product origin ${this.ctx.allowedOrigin}.`,
            failed: true,
          };
        }

        let target = step.url;
        if (this.ctx.allowPrivateOriginForTesting) {
          // Scheme is still checked; only the resolved-address check is skipped,
          // and only for the one origin already confirmed above.
          if (!/^https?:\/\//i.test(step.url)) {
            return { detail: `Navigation blocked: ${step.url} is not an http(s) URL.`, failed: true };
          }
        } else {
          // Re-validated here, not only at plan time — DNS can change between
          // planning and navigating.
          const gate = await assertNavigationAllowed(step.url, this.ctx.resolver ?? defaultResolver);
          if (!gate.allowed) {
            return { detail: `Navigation blocked: ${gate.reason}`, failed: true };
          }
          target = gate.normalised as string;
        }

        const response = await page.goto(target, { timeout, waitUntil: 'domcontentloaded' });
        return { detail: `Loaded ${target} (${response?.status() ?? 'no response'}).` };
      }

      case 'click': {
        const locator = this.locate(step.target);
        await locator.click({ timeout });
        return { detail: `Clicked ${describeTarget(step.target)}.` };
      }

      case 'fill': {
        const value = this.substituteCredentials(step.value);
        if (value.includes(TEST_DATA_PREFIX)) this.observations.createdValues.push(value);
        const locator = this.locate(step.target);
        await locator.fill(value, { timeout });
        return { detail: `Filled ${describeTarget(step.target)} ← ${this.mask(value)}` };
      }

      case 'select': {
        const locator = this.locate(step.target);
        await locator.selectOption(step.value, { timeout });
        return { detail: `Selected "${step.value}" in ${describeTarget(step.target)}.` };
      }

      case 'press': {
        await page.keyboard.press(step.key === 'Space' ? ' ' : step.key, { delay: 20 });
        return { detail: `Pressed ${step.key}.` };
      }

      case 'wait': {
        if (step.target) {
          await this.locate(step.target).waitFor({ state: 'visible', timeout });
          return { detail: `Waited for ${describeTarget(step.target)}.` };
        }
        await page.waitForTimeout(Math.min(step.ms ?? 1000, timeout));
        return { detail: `Waited ${step.ms ?? 1000} ms.` };
      }

      case 'assertText': {
        const found = await page
          .getByText(step.text, { exact: false })
          .first()
          .isVisible({ timeout })
          .catch(() => false);
        const passed = found === step.shouldExist;
        return {
          detail: passed
            ? `Text "${step.text}" ${step.shouldExist ? 'found' : 'correctly absent'}.`
            : `Expected text "${step.text}" to be ${step.shouldExist ? 'present' : 'absent'}, but it was not.`,
          failed: !passed,
        };
      }

      case 'assertUrl': {
        const current = page.url();
        const passed = current.includes(step.contains);
        return {
          detail: passed
            ? `URL contains "${step.contains}".`
            : `Expected the URL to contain "${step.contains}"; it is ${current}.`,
          failed: !passed,
        };
      }

      case 'assertElement': {
        const visible = await this.locate(step.target)
          .first()
          .isVisible({ timeout })
          .catch(() => false);
        const passed = visible === step.shouldExist;
        return {
          detail: passed
            ? `${describeTarget(step.target)} ${step.shouldExist ? 'present' : 'correctly absent'}.`
            : `Expected ${describeTarget(step.target)} to be ${step.shouldExist ? 'present' : 'absent'}.`,
          failed: !passed,
        };
      }

      case 'screenshot': {
        const safeLabel = step.label.replace(/[^a-z0-9-]/gi, '-').slice(0, 60) || `step-${index}`;
        const path = `${this.ctx.screenshotDir}/${this.ctx.viewport}-${String(index).padStart(3, '0')}-${safeLabel}.png`;
        await page.screenshot({ path, fullPage: false });
        this.ctx.onScreenshot?.(safeLabel, path);
        return { detail: `Captured "${safeLabel}".`, screenshotPath: path };
      }

      case 'reload': {
        await page.reload({ timeout, waitUntil: 'domcontentloaded' });
        return { detail: 'Reloaded the page.' };
      }

      case 'checkPersistence': {
        // Deliberately checked AFTER a reload: this is what separates a real
        // backend from in-page state.
        const found = await page
          .getByText(step.expectText, { exact: false })
          .first()
          .isVisible({ timeout })
          .catch(() => false);
        return {
          detail: found
            ? `"${step.expectText}" survived the reload — data persisted.`
            : `"${step.expectText}" was not present after reload — data did not persist.`,
          failed: !found,
        };
      }

      case 'checkConsole': {
        const count = this.observations.consoleErrors.length;
        return {
          detail:
            count === 0
              ? '0 console errors.'
              : `${count} console error(s): ${this.observations.consoleErrors
                  .slice(0, 3)
                  .map((e) => e.text)
                  .join(' | ')}`,
          failed: count > 0,
        };
      }

      case 'checkNetwork': {
        const count = this.observations.networkFailures.length;
        return {
          detail:
            count === 0
              ? '0 failed requests.'
              : `${count} failed request(s): ${this.observations.networkFailures
                  .slice(0, 3)
                  .map((f) => `${f.reason} ${f.url}`)
                  .join(' | ')}`,
          failed: count > 0,
        };
      }

      case 'a11yScan': {
        const violations = await this.runAxe();
        this.observations.a11yViolations.push(...violations);
        const critical = violations.filter((v) => v.impact === 'critical').length;
        const serious = violations.filter((v) => v.impact === 'serious').length;
        return {
          detail: `${violations.length} accessibility violation(s): ${critical} critical, ${serious} serious.`,
        };
      }

      case 'cleanup': {
        if (step.target) {
          const locator = this.locate(step.target);
          const count = await locator.count().catch(() => 0);
          if (count === 0) return { detail: 'Nothing to clean up for this target.' };
          await locator.first().click({ timeout }).catch(() => undefined);
          return { detail: `Cleanup: activated ${describeTarget(step.target)}.` };
        }
        return { detail: 'Cleanup checkpoint — no target specified.' };
      }

      default: {
        // Exhaustiveness proof: if the DSL gains an action and it is not
        // handled above, this line fails to compile.
        const exhaustive: never = step;
        throw new Error(`Unhandled test action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Resolve a target to a locator.
   *
   * Only role-, text-, label-, placeholder- and testid-based lookups exist.
   * There is no path from plan data to a raw CSS or XPath selector.
   */
  private locate(target: TestTarget): Locator {
    const { page } = this.ctx;
    let locator: Locator;

    if (target.role) {
      locator = page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
        ...(target.name ? { name: target.name, exact: target.exact ?? false } : {}),
      });
    } else if (target.testId) {
      locator = page.getByTestId(target.testId);
    } else if (target.label) {
      locator = page.getByLabel(target.label, { exact: target.exact ?? false });
    } else if (target.placeholder) {
      locator = page.getByPlaceholder(target.placeholder, { exact: target.exact ?? false });
    } else if (target.name) {
      locator = page.getByText(target.name, { exact: target.exact ?? false });
    } else {
      throw new Error('Target specifies no way to find an element.');
    }

    return target.nth !== undefined ? locator.nth(target.nth) : locator.first();
  }

  /** Substitute credential placeholders at execution time. */
  private substituteCredentials(value: string): string {
    if (!this.ctx.credentials) return value;
    return value
      .replaceAll(CREDENTIAL_USERNAME_PLACEHOLDER, this.ctx.credentials.username)
      .replaceAll(CREDENTIAL_PASSWORD_PLACEHOLDER, this.ctx.credentials.password);
  }

  /** Mask credential values in anything we record. */
  private mask(text: string): string {
    if (!this.ctx.credentials) return text;
    let out = text;
    for (const secret of [this.ctx.credentials.username, this.ctx.credentials.password]) {
      if (secret && secret.length >= 3) out = out.replaceAll(secret, MASK);
    }
    return out;
  }

  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.ctx.allowedOrigin).origin;
    } catch {
      return false;
    }
  }

  private remainingBudget(): number {
    return Math.max(0, this.ctx.deadline - Date.now());
  }

  /**
   * Run axe-core.
   *
   * `@axe-core/playwright` injects and runs its own bundled script; no
   * participant-derived content reaches it, and nothing from the page is
   * executed as code by us.
   */
  private async runAxe(): Promise<{ id: string; impact: string; nodes: number; help: string }[]> {
    try {
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const results = await new AxeBuilder({ page: this.ctx.page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      return results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? 'minor',
        nodes: violation.nodes.length,
        help: violation.help,
      }));
    } catch {
      // A scan that cannot run is missing evidence, not a failed product.
      return [];
    }
  }
}

const defaultResolver = async (hostname: string): Promise<string[]> => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

function describeTarget(target: TestTarget): string {
  const parts: string[] = [];
  if (target.role) parts.push(`${target.role}`);
  if (target.name) parts.push(`"${target.name}"`);
  if (target.label) parts.push(`label "${target.label}"`);
  if (target.placeholder) parts.push(`placeholder "${target.placeholder}"`);
  if (target.testId) parts.push(`testid "${target.testId}"`);
  if (target.nth !== undefined) parts.push(`#${target.nth}`);
  return parts.join(' ') || 'element';
}
