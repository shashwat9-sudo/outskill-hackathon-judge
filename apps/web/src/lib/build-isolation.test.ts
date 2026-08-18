import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A running server and a build must not share a directory.
 *
 * `next build` writes BUILD_ID and the client manifests into the output
 * directory. A `next dev` process serving from that same directory has its
 * module graph replaced underneath it, and the next request fails with
 * `__webpack_modules__[moduleId] is not a function`. The browser shows a blank
 * white page and the server log blames the React Server Components bundler.
 *
 * This happened during the Phase A acceptance run. The acceptance server was
 * live on port 3000 while the test gate ran `npm run build` — and `npm run
 * test:e2e`, which builds first. The result looked exactly like an application
 * bug in the page that had just been changed, and cost a round trip to
 * diagnose.
 *
 * The fix is a separate output directory for any long-running server. This test
 * keeps that escape hatch present, because without it the collision returns
 * silently and only shows up as a blank page at the worst moment.
 */

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../../next.config.mjs');

describe('the build output directory', () => {
  it('can be moved with an environment variable', async () => {
    const config = await readFile(CONFIG, 'utf8');
    expect(config).toMatch(/distDir:\s*process\.env\.NEXT_DIST_DIR/);
  });

  it('still defaults to .next, so nothing changes for a normal build', async () => {
    const config = await readFile(CONFIG, 'utf8');
    expect(config).toMatch(/NEXT_DIST_DIR\s*\?\?\s*'\.next'/);
  });

  it('explains what breaks without it', async () => {
    // The next person to tidy this away needs to know what it cost.
    const config = await readFile(CONFIG, 'utf8');
    expect(config).toMatch(/__webpack_modules__/);
    expect(config).toMatch(/blank white screen/i);
  });
});

describe('alternate build directories', () => {
  it('are ignored by git', async () => {
    // `.next-acceptance` holds a full build. Committing one would add tens of
    // megabytes of generated output to the repository.
    const gitignore = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.gitignore'),
      'utf8',
    );
    expect(gitignore).toMatch(/^\.next-\*\/$/m);
  });
});
