import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What may enter a browser bundle.
 *
 * Client components import from `@ohj/shared/client`, never from the root
 * barrel. The root barrel reaches Argon2, `node:crypto` and the Postgres
 * driver — none of which can run in a browser, and the first two of which
 * would be a real disclosure risk if they were shipped there.
 *
 * The build does catch this today, but only because `pg` cannot be bundled at
 * all. A module that reaches, say, `Buffer` would be silently polyfilled and
 * shipped. This checks the rule itself rather than one symptom of breaking it.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? [full] : [];
    }),
  );
  return files.flat();
}

async function clientComponents(): Promise<{ path: string; source: string }[]> {
  const files = await sourceFiles(SRC);
  const read = await Promise.all(
    files.map(async (path) => ({ path, source: await readFile(path, 'utf8') })),
  );
  // The directive must be the first statement, so checking the opening bytes
  // avoids matching the word inside a comment further down.
  return read.filter(({ source }) => /^\s*(['"])use client\1/.test(source));
}

describe('client components', () => {
  it('exist, so this test is testing something', async () => {
    expect((await clientComponents()).length).toBeGreaterThan(0);
  });

  it('never import the root @ohj/shared barrel', async () => {
    const offenders = (await clientComponents())
      .filter(({ source }) => /from ['"]@ohj\/shared['"]/.test(source))
      .map(({ path }) => path.replace(SRC, ''));

    expect(
      offenders,
      'Client components must import from "@ohj/shared/client". The root barrel ' +
        'reaches Argon2, node:crypto and the Postgres driver.',
    ).toEqual([]);
  });

  it('never import the server-only store', async () => {
    const offenders = (await clientComponents())
      .filter(({ source }) => /from ['"]@\/lib\/store['"]/.test(source))
      .map(({ path }) => path.replace(SRC, ''));

    expect(offenders).toEqual([]);
  });

  it('never import a node built-in', async () => {
    const offenders = (await clientComponents())
      .filter(({ source }) => /from ['"]node:/.test(source))
      .map(({ path }) => path.replace(SRC, ''));

    expect(offenders).toEqual([]);
  });
});
