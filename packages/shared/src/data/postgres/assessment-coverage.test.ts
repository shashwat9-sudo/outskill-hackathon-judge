import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { composePostgresDataStore, storeCapabilities } from './store';
import { createInMemoryStorage } from './storage';
import { FeatureUnavailableError } from './unavailable';

/**
 * Does the production store actually do what it claims?
 *
 * `capabilities: { assessment: true }` is what makes the admin UI offer
 * judging at all. Setting it is a claim, and the whole point of the capability
 * design was that the system must not claim more than it does — an empty queue
 * and a zero score render as real answers.
 *
 * So the flag is checked against the store rather than trusted: every method on
 * the interface must be present, callable, and not the throwing stub that stood
 * in for it while the repository was unwritten.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

let db: PgliteHandle;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

function store() {
  return composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 'test-secret-that-is-long-enough-for-hmac',
    credentialKey: 'a'.repeat(64),
    credentialKeyVersion: 1,
  });
}

/**
 * The interface is the source of truth, read from the file rather than a hand
 * copy. A method added to `AssessmentStore` tomorrow is covered by this test
 * the moment it is declared.
 */
async function declaredMethods(interfaceName: string, file = '../store.ts'): Promise<string[]> {
  const source = await readFile(resolve(HERE, file), 'utf8');
  // Tolerant of `extends`: `AssessmentStore` gained a base interface when
  // evidence upload moved into its own file, and a lookup that assumed the
  // declaration ended in `{` silently found nothing and reported zero methods.
  const match = new RegExp(`export interface ${interfaceName}\\s*(?:extends [^{]+)?\\{`).exec(source);
  expect(match, `${interfaceName} should exist`).not.toBeNull();
  const start = match!.index;
  const block = source.slice(start, source.indexOf('\n}', start));

  // Method signatures at one level of indentation: `  name(` or `  name<T>(`.
  return [...block.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)[<(]/gm)].map((m) => m[1]!);
}

describe('the assessment repository', () => {
  it('implements every method the interface declares, its own and inherited', async () => {
    const own = await declaredMethods('AssessmentStore');
    const inherited = await declaredMethods('EvidenceStore', './repositories/evidence.ts');

    // 40: the 36 judging methods plus setFeedbackStatus,
    // listJobsNeedingFeedback, listPendingFeedbackJobs and
    // getFeedbackCoverage, which record, find and count missing participant
    // feedback without touching judging state.
    expect(own).toHaveLength(40);
    // Evidence upload lives in its own file because it is the one part of the
    // assessment surface that needs a Storage credential.
    expect(inherited).toEqual([
      'createEvidenceUploadTicket',
      'confirmEvidenceUpload',
      'getEvidenceObject',
    ]);

    const implemented = store().assessment as unknown as Record<string, unknown>;
    const missing = [...own, ...inherited].filter(
      (name) => typeof implemented[name] !== 'function',
    );

    expect(missing, 'Methods declared but not implemented').toEqual([]);
  });

  it('has no method that is still the throwing stub', async () => {
    // The stub satisfies the type. Without this check a repository could be
    // "complete" while half of it refused to run.
    const declared = await declaredMethods('AssessmentStore');
    const assessment = store().assessment as unknown as Record<string, (...a: unknown[]) => unknown>;

    const stubs: string[] = [];
    for (const name of declared) {
      try {
        // Called with nothing: a real method fails on its arguments or its SQL,
        // a stub throws FeatureUnavailableError before looking at them.
        await assessment[name]!();
      } catch (error) {
        if (error instanceof FeatureUnavailableError) stubs.push(name);
      }
    }

    expect(stubs, 'Methods still backed by the unavailable stub').toEqual([]);
  });
});

describe('the ranking repository', () => {
  it('implements all 8 methods the interface declares', async () => {
    const declared = await declaredMethods('RankingStore');
    // The six ranking and selection methods plus listRankedResults, which
    // reads the stored snapshot for the results-and-feedback export, and
    // listSubmissionAudit, which reads every submission for the audit export.
    expect(declared).toHaveLength(8);

    const implemented = store().ranking as unknown as Record<string, unknown>;
    const missing = declared.filter((name) => typeof implemented[name] !== 'function');

    expect(missing).toEqual([]);
  });

  it('has no method that is still the throwing stub', async () => {
    const declared = await declaredMethods('RankingStore');
    const ranking = store().ranking as unknown as Record<string, (...a: unknown[]) => unknown>;

    const stubs: string[] = [];
    for (const name of declared) {
      try {
        await ranking[name]!();
      } catch (error) {
        if (error instanceof FeatureUnavailableError) stubs.push(name);
      }
    }

    expect(stubs).toEqual([]);
  });
});

describe('the declared capabilities', () => {
  it('match what the store can actually do', () => {
    expect(storeCapabilities(store())).toEqual({ assessment: true, ranking: true });
  });

  it('are read from the store rather than assumed', () => {
    // A driver that declares nothing is treated as fully capable, which is
    // correct for the memory driver and would be wrong to assume of a new
    // partial one.
    expect(storeCapabilities({ driver: 'memory' } as never)).toEqual({
      assessment: true,
      ranking: true,
    });
  });
});
