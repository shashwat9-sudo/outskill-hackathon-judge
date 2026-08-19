/**
 * Browser run orchestration.
 *
 * Launches an isolated context per submission, executes a validated plan under
 * a hard wall-clock budget, captures evidence, and always attempts cleanup —
 * including when the run times out or throws.
 *
 * Isolation properties: a fresh context per submission, no persistent profile,
 * no shared storage state, downloads disabled, and a forced teardown on the
 * budget. A hostile product cannot outlive its own run.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { TestStep } from '@ohj/shared';
import { PlanExecutor, type RunObservations, type StepResult } from './executor';
import { createEgressProxy, egressProxyArgs, type EgressProxy } from './egress-proxy';

export interface BrowserRunOptions {
  productUrl: string;
  steps: TestStep[];
  credentials: { username: string; password: string } | null;
  budgetMs: number;
  viewport: 'desktop' | 'mobile';
  screenshotDir: string;
  traceDir: string | null;
  headless: boolean;
  /**
   * TEST ONLY — permits a loopback/private product origin so the executor can
   * run against the local fixture app. Ignored entirely when NODE_ENV is
   * 'production', so a deployed worker cannot honour it.
   */
  allowPrivateOriginForTesting?: boolean;
}

export interface BrowserRunResult {
  viewport: 'desktop' | 'mobile';
  status: 'passed' | 'partial' | 'failed' | 'error';
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  timedOut: boolean;
  browserVersion: string;
  tracePath: string | null;
  steps: StepResult[];
  observations: RunObservations;
  cleanupStatus: 'complete' | 'partial' | 'not_attempted' | 'failed';
  error: string | null;
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function runBrowserPlan(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const startedAt = new Date();
  const deadline = Date.now() + options.budgetMs;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let timedOut = false;
  let error: string | null = null;
  let cleanupStatus: BrowserRunResult['cleanupStatus'] = 'not_attempted';
  const steps: StepResult[] = [];
  let observations: RunObservations = {
    consoleErrors: [],
    networkFailures: [],
    a11yViolations: [],
    createdValues: [],
  };
  let browserVersion = 'unknown';
  let tracePath: string | null = null;
  let proxy: EgressProxy | null = null;

  try {
    /*
     * Every packet leaves through our proxy, or does not leave.
     *
     * A browser configured with an HTTP proxy does not resolve hostnames — it
     * hands the name over and asks for the connection — so this is what takes
     * DNS away from Chromium and closes rebinding. Navigations, redirects,
     * subresources and WebSockets all go the same way.
     *
     * If the proxy cannot be started, the run does not happen. Launching without
     * it would mean judging a stranger's URL with nothing between their DNS and
     * our network.
     */
    proxy = await createEgressProxy({
      allowLoopbackForTesting: options.allowPrivateOriginForTesting === true,
    });

    browser = await chromium.launch({
      headless: options.headless,
      args: [
        '--disable-dev-shm-usage',
        // No extensions, no background networking — the judge is the only actor.
        '--disable-extensions',
        '--disable-background-networking',
        ...egressProxyArgs(proxy),
      ],
    });
    browserVersion = `Chromium ${browser.version()}`;

    context = await browser.newContext({
      viewport: VIEWPORTS[options.viewport],
      ...(options.viewport === 'mobile'
        ? { userAgent: MOBILE_USER_AGENT, isMobile: true, hasTouch: true }
        : {}),
      // A product must never be able to write a file to the worker.
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      // Fixed locale and timezone so runs are comparable between submissions.
      locale: 'en-GB',
      timezoneId: 'Asia/Kolkata',
    });

    if (options.traceDir) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      tracePath = `${options.traceDir}/${options.viewport}.zip`;
    }

    const page = await context.newPage();
    // The escape hatch is refused outright in production, regardless of caller.
    const allowPrivateOrigin =
      options.allowPrivateOriginForTesting === true && process.env.NODE_ENV !== 'production';

    const executor = new PlanExecutor({
      page,
      context,
      allowedOrigin: options.productUrl,
      credentials: options.credentials,
      deadline,
      screenshotDir: options.screenshotDir,
      viewport: options.viewport,
      allowPrivateOriginForTesting: allowPrivateOrigin,
    });
    executor.attachListeners();

    // Main pass. Cleanup steps are deferred so they still run after a timeout.
    const mainSteps = options.steps.filter((step) => !step.isCleanup);
    const cleanupSteps = options.steps.filter((step) => step.isCleanup);

    for (const [index, step] of mainSteps.entries()) {
      if (Date.now() >= deadline) {
        timedOut = true;
        // Record the untouched remainder as skipped rather than silently
        // dropping it — a shorter run must be visibly shorter.
        for (let i = index; i < mainSteps.length; i++) {
          steps.push({
            stepIndex: i,
            action: mainSteps[i]?.action ?? 'unknown',
            status: 'skipped',
            durationMs: 0,
            detail: 'Skipped — the run budget was exhausted.',
            screenshotPath: null,
            errorMessage: null,
          });
        }
        break;
      }
      steps.push(await executor.executeStep(step, index));
    }

    // Cleanup runs on a small dedicated budget so a timed-out run still tidies
    // up after itself. We created data inside someone else's product; leaving
    // it behind is not acceptable.
    if (cleanupSteps.length > 0) {
      const cleanupExecutor = new PlanExecutor({
        page,
        context,
        allowedOrigin: options.productUrl,
        credentials: options.credentials,
        deadline: Date.now() + 30_000,
        screenshotDir: options.screenshotDir,
        viewport: options.viewport,
        allowPrivateOriginForTesting: allowPrivateOrigin,
      });
      let succeeded = 0;
      for (const [index, step] of cleanupSteps.entries()) {
        const result = await cleanupExecutor.executeStep(step, mainSteps.length + index);
        steps.push(result);
        if (result.status === 'passed') succeeded += 1;
      }
      cleanupStatus =
        succeeded === cleanupSteps.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed';
    }

    observations = executor.results;

    if (options.traceDir && tracePath) {
      await context.tracing.stop({ path: tracePath }).catch(() => {
        tracePath = null;
      });
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    // Always tear down, even on a throw — a leaked context is a leaked browser
    // process holding an untrusted page open.
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    // The proxy outlives the browser only long enough to close cleanly.
    await proxy?.close().catch(() => undefined);
  }

  const finishedAt = new Date();
  const failedSteps = steps.filter((s) => s.status === 'failed' || s.status === 'error').length;
  const passedSteps = steps.filter((s) => s.status === 'passed').length;

  const status: BrowserRunResult['status'] = error
    ? 'error'
    : failedSteps === 0 && !timedOut
      ? 'passed'
      : passedSteps > 0
        ? 'partial'
        : 'failed';

  return {
    viewport: options.viewport,
    status,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    timedOut,
    browserVersion,
    tracePath,
    steps,
    observations,
    cleanupStatus,
    error,
  };
}

/**
 * Summarise a run for the scoring stage.
 *
 * Deliberately factual. Interpretation belongs to the scorer, and phrasing this
 * as a verdict here would let one component's opinion masquerade as evidence.
 */
export function summariseRun(result: BrowserRunResult): string {
  const lines: string[] = [
    `Viewport: ${result.viewport}`,
    `Outcome: ${result.status}${result.timedOut ? ' (hit the time budget)' : ''}`,
    `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `Steps: ${result.steps.filter((s) => s.status === 'passed').length} passed, ${
      result.steps.filter((s) => s.status === 'failed').length
    } failed, ${result.steps.filter((s) => s.status === 'skipped').length} skipped`,
    `Console errors: ${result.observations.consoleErrors.length}`,
    `Failed requests: ${result.observations.networkFailures.length}`,
    `Accessibility violations: ${result.observations.a11yViolations.length}`,
    `Cleanup: ${result.cleanupStatus}`,
    '',
    'Step detail:',
  ];

  for (const step of result.steps) {
    lines.push(`  ${String(step.stepIndex + 1).padStart(2)}. [${step.status}] ${step.action} — ${step.detail}`);
  }

  if (result.observations.a11yViolations.length > 0) {
    lines.push('', 'Accessibility violations:');
    for (const violation of result.observations.a11yViolations.slice(0, 10)) {
      lines.push(`  - ${violation.id} (${violation.impact}, ${violation.nodes} node(s)): ${violation.help}`);
    }
  }

  if (result.timedOut) {
    lines.push(
      '',
      'NOTE: this run hit its time budget. Steps after the last completed one were never attempted — treat their evidence as MISSING, not as failure.',
    );
  }

  return lines.join('\n');
}
