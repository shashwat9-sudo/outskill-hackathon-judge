import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ASSESSMENT_CONFIG, DEMO_PROMPT_VERSION } from '@ohj/shared';
import { PROMPT_VERSION } from './prompts';

/**
 * One prompt version, everywhere it is written down.
 *
 * Cohorts created through the admin screen used to be stamped
 * `assessment-prompts-v1` by a string literal while the prompts themselves
 * were v2, so an audit of "which prompts judged this cohort" answered wrongly.
 * The shared package cannot import this one (the dependency runs the other
 * way), so its copies of the version are pinned here instead.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe('the prompt version', () => {
  it('is what every cohort default carries', () => {
    expect(DEFAULT_ASSESSMENT_CONFIG.promptVersion).toBe(PROMPT_VERSION);
    expect(DEMO_PROMPT_VERSION).toBe(PROMPT_VERSION);
  });

  it('is stamped on cohorts created by the admin action, never a literal', async () => {
    const source = await readFile(resolve(HERE, '../../../apps/web/src/server/admin-actions.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/assessment-prompts-v\d/);
    expect(code).toMatch(/promptVersion:\s*PROMPT_VERSION/);
    expect(code).toMatch(/import \{ PROMPT_VERSION \} from '@ohj\/ai'/);
  });

  it('is the version the prompts themselves declare', () => {
    expect(PROMPT_VERSION).toBe('assessment-prompts-v2');
  });
});
