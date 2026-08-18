import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPLETED_EXAMPLE,
  EXAMPLE_BUGS,
  EXAMPLE_TEAM,
  EXAMPLE_TEST_STEPS,
  FIELD_GUIDANCE,
  STEP_GUIDANCE,
  WALKTHROUGH_SLIDES,
  collectMissingItems,
  evaluateCompleteness,
  fieldDomId,
  fieldGuide,
  missingSummaryLabel,
  requirementLine,
} from '@ohj/shared/client';

/**
 * Guidance cannot touch a submission.
 *
 * The whole point of the walkthrough, the examples and the help menu is that
 * they explain the form without participating in it. That is easy to say and
 * easy to lose: one `import { saveDraftAction }` in a help component, added in
 * good faith to "remember where they got to", and viewing an example starts
 * writing to a team's entry.
 *
 * So it is proved rather than asserted, two ways.
 *
 * Structurally: the guidance modules are read from disk, their imports followed
 * transitively, and the resulting graph checked for any path that can write. A
 * guidance file that reaches a server action fails here, whether or not anyone
 * calls it.
 *
 * Behaviourally: every guidance function is run against a deeply frozen draft.
 * A frozen object throws on assignment in strict mode — and ES modules are
 * always strict — so a function that mutates its input cannot pass.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');

/** Everything a learner reads to understand the form, rather than to fill it in. */
const GUIDANCE_FILES = [
  'apps/web/src/app/submit/_components/guidance.tsx',
  'apps/web/src/app/submit/_components/walkthrough.tsx',
  'apps/web/src/app/submit/_components/help-menu.tsx',
  'apps/web/src/app/submit/example/page.tsx',
  'packages/shared/src/content/learner-guidance.ts',
  'packages/shared/src/content/completed-example.ts',
  'packages/shared/src/domain/missing-items.ts',
];

/**
 * Anything that can change a submission.
 *
 * Named rather than pattern-matched: a list of real identifiers is checkable
 * against the codebase, and `participant-actions.ts` is the only module in the
 * application that holds a participant write.
 */
const WRITE_SURFACE = [
  'saveDraftAction',
  'finalSubmitAction',
  'uploadDeckAction',
  'setDemoVideoAction',
  'endSessionAction',
  'participant-actions',
  'attachArtifact',
  'finaliseSubmission',
  'saveDraft',
  'getStoreAsync',
  'getStore',
];

// --------------------------------------------------------------------------
// Reading the graph
// --------------------------------------------------------------------------

/** Statements only. A comment naming a forbidden thing is not a call to it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Map a specifier to a repo-relative file, or null if it leaves our code. */
async function resolveSpecifier(fromFile: string, specifier: string): Promise<string | null> {
  let base: string;

  if (specifier.startsWith('.')) {
    base = join(dirname(fromFile), specifier);
  } else if (specifier === '@ohj/shared/client') {
    base = 'packages/shared/src/client';
  } else if (specifier === '@ohj/shared') {
    base = 'packages/shared/src/index';
  } else if (specifier.startsWith('@/')) {
    base = join('apps/web/src', specifier.slice(2));
  } else {
    // node_modules, next/*, react — not ours, and not able to reach our store.
    return null;
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      await readFile(resolve(REPO, candidate), 'utf8');
      return candidate;
    } catch {
      // Try the next extension.
    }
  }
  return null;
}

/** Every first-party file reachable from the guidance surface. */
async function reachableFiles(entries: string[]): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;

    const source = await readFile(resolve(REPO, file), 'utf8');
    seen.set(file, source);

    for (const specifier of importsOf(code(source))) {
      const resolved = await resolveSpecifier(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

/**
 * Barrels are excluded from the write check.
 *
 * `@ohj/shared` re-exports the whole package, including the repositories, so
 * following it would flag every guidance file for reaching code it never names.
 * What matters is whether a guidance module *imports a write* — which is
 * checked directly, per file, below.
 */
const BARRELS = new Set(['packages/shared/src/index.ts', 'packages/shared/src/client.ts']);

// --------------------------------------------------------------------------

describe('the guidance surface cannot write', () => {
  it('names no server action and no store', async () => {
    for (const file of GUIDANCE_FILES) {
      const source = code(await readFile(resolve(REPO, file), 'utf8'));
      for (const forbidden of WRITE_SURFACE) {
        expect(source, `${file} referenced "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it('reaches no write through any import, however deep', async () => {
    const graph = await reachableFiles(GUIDANCE_FILES);

    // The traversal must actually have found something, or this passes empty.
    expect(graph.size).toBeGreaterThanOrEqual(GUIDANCE_FILES.length);

    for (const [file, source] of graph) {
      if (BARRELS.has(file)) continue;
      const statements = code(source);
      for (const forbidden of WRITE_SURFACE) {
        expect(statements, `${file}, reachable from guidance, referenced "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it('declares no server module anywhere in that graph', async () => {
    const graph = await reachableFiles(GUIDANCE_FILES);
    for (const [file, source] of graph) {
      expect(source.slice(0, 200), `${file} is a server module`).not.toMatch(/['"]use server['"]/);
    }
  });

  it('is checking a graph that would notice — the guard catches a planted write', async () => {
    // A mutation check on the checker: the same traversal run against the form,
    // which legitimately writes, must fail. Without this the test above passes
    // just as happily on an empty file list or a broken resolver.
    const graph = await reachableFiles(['apps/web/src/app/submit/_components/submission-form.tsx']);
    const everything = [...graph.values()].map(code).join('\n');
    expect(everything).toContain('saveDraftAction');
  });
});

describe('the walkthrough writes nothing but its own flag', () => {
  const FILE = 'apps/web/src/app/submit/_components/walkthrough.tsx';

  it('touches storage exactly once, under the tour key', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));

    const writes = source.match(/localStorage\.setItem/g) ?? [];
    expect(writes, 'one write, and only one').toHaveLength(1);
    expect(source).toMatch(/setItem\(seenKey\(/);
    expect(source).toMatch(/WALKTHROUGH_SEEN_KEY/);

    // Nothing else in browser storage, and no cookie.
    expect(source).not.toMatch(/sessionStorage|document\.cookie|indexedDB/);
  });

  it('sends nothing anywhere', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/);
  });

  it('never records what a team typed — only that a tour was seen', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));
    // The stored value is a timestamp. A draft, an answer or a version number
    // in local storage would be submission data living outside the database.
    expect(source).toMatch(/setItem\(seenKey\(cohortId, groupNumber\), new Date\(\)\.toISOString\(\)\)/);
  });
});

describe('the completed example is application-owned', () => {
  const FILE = 'packages/shared/src/content/completed-example.ts';

  it('is built from the guidance module and nothing else', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));
    const specifiers = importsOf(source);
    expect(specifiers).toEqual(['./learner-guidance']);
  });

  it('reads no submission, no store and no database', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));
    for (const forbidden of ['store', 'Store', 'submission_', 'select ', 'ParticipantView']) {
      expect(source, `the example referenced "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('shares its answers with the form rather than copying them', () => {
    // Every example answer that a field also offers inline must be the same
    // string. Two copies of "what a good answer looks like" disagree eventually,
    // and the learner who spots it trusts neither.
    let shared = 0;
    for (const section of COMPLETED_EXAMPLE) {
      for (const answer of section.answers) {
        const inline = FIELD_GUIDANCE[answer.path]?.example;
        if (!inline) continue;
        shared += 1;
        expect(answer.answer, `${answer.path} drifted from its inline example`).toBe(inline);
      }
    }
    expect(shared, 'the example should mostly be shared text').toBeGreaterThan(15);
  });

  it('describes nothing that could be a real team', () => {
    const everything = JSON.stringify([
      COMPLETED_EXAMPLE,
      EXAMPLE_TEAM,
      EXAMPLE_TEST_STEPS,
      EXAMPLE_BUGS,
    ]);

    // Real allocations run 1–900; the example team is group 0.
    expect(EXAMPLE_TEAM.groupNumber).toMatch(/^0 /);
    // No receipt identity, no access code shape, no real address.
    expect(everything).not.toMatch(/OSK-[A-Z0-9]+-\d+/);
    for (const email of everything.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []) {
      expect(email, 'example contacts must be example.com').toMatch(/@example\.com$/);
    }
    expect(everything).not.toContain('outskill.com');
  });
});

describe('the example page is read-only by construction', () => {
  const FILE = 'apps/web/src/app/submit/example/page.tsx';

  it('renders no form control at all', async () => {
    const source = code(await readFile(resolve(REPO, FILE), 'utf8'));
    // Not "disabled inputs" — no inputs. A disabled attribute is one careless
    // refactor from being removed; an element that does not exist is not.
    for (const element of ['<input', '<textarea', '<select', '<form', '<button']) {
      expect(source, `the example page rendered ${element}`).not.toContain(element);
    }
    expect(source).not.toMatch(/onChange|onSubmit|onClick|action=/);
  });

  it('offers no way to copy an answer into the real form', async () => {
    const source = await readFile(resolve(REPO, FILE), 'utf8');
    for (const forbidden of [
      'Copy example',
      'Use this answer',
      'Fill for me',
      'clipboard',
      'Generate',
      'Autofill',
      'autofill',
    ]) {
      expect(source, `the example page offered "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('shows no ticked declaration', async () => {
    // Seven pre-ticked boxes would teach exactly the wrong thing about what
    // pressing one means.
    const source = await readFile(resolve(REPO, FILE), 'utf8');
    expect(source).not.toMatch(/checked/);
    expect(source).toContain('Nothing is ever ticked for you');
  });
});

describe('nothing in the learner UI writes an answer for anyone', () => {
  it('offers no autofill, anywhere on the submission surface', async () => {
    const files = [
      ...GUIDANCE_FILES,
      'apps/web/src/app/submit/_components/submission-form.tsx',
      'apps/web/src/app/submit/portal/page.tsx',
      'apps/web/src/app/submit/guide/page.tsx',
    ];

    for (const file of files) {
      const source = await readFile(resolve(REPO, file), 'utf8');
      for (const forbidden of [
        'Copy example',
        'Use this answer',
        'Fill for me',
        'Generate with AI',
        'Generate answer',
        'Write this with AI',
        'Improve my answer',
        'navigator.clipboard',
      ]) {
        expect(source, `${file} offered "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it('never pre-ticks a declaration', async () => {
    const source = code(
      await readFile(resolve(REPO, 'apps/web/src/app/submit/_components/submission-form.tsx'), 'utf8'),
    );
    // Every declaration checkbox reads its state from the draft, and the draft
    // seeds declarations from what the team actually stored.
    expect(source).toMatch(/checked=\{Boolean\(declarations\[key\]\)\}/);
    expect(source).not.toMatch(/checked=\{true\}|defaultChecked/);
  });

  it('never writes an example into the draft', async () => {
    const source = code(
      await readFile(resolve(REPO, 'apps/web/src/app/submit/_components/submission-form.tsx'), 'utf8'),
    );
    // `update(...)` is the only path into the draft, and every call site must
    // pass a value that came from an event target.
    const calls = source.match(/update\('[a-z]+',\s*\{[^}]*\}/g) ?? [];
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      expect(call, `an update did not come from user input: ${call}`).toMatch(
        /e\.target|nextMembers|nextSteps|nextBugs|nextFeatures|idea\.id/,
      );
    }
    expect(source).not.toMatch(/update\([^)]*FIELD_GUIDANCE/);
    expect(source).not.toMatch(/update\([^)]*COMPLETED_EXAMPLE/);
    expect(source).not.toMatch(/update\([^)]*\.example/);
  });
});

// --------------------------------------------------------------------------
// Behavioural: guidance run against something it cannot change
// --------------------------------------------------------------------------

/** Freeze an object graph, so any write throws under module strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

const PART_FILLED_DRAFT = deepFreeze({
  team: {
    groupNumber: 12,
    leadName: 'A Learner',
    leadEmail: 'learner@example.com',
    leadPhone: '+91 90000 00001',
    members: [{ fullName: 'A Learner', contribution: 'Built the whole thing themselves.' }],
  },
  product: { productName: 'Something', primaryUser: 'People who need it.' },
  live: { productUrl: 'https://example.com', coreTestSteps: [] },
  artifacts: {},
  learning: { bugsFixed: [{}, {}, {}] },
  declarations: { ownedByTeam: true },
});

describe('viewing guidance changes nothing', () => {
  it('leaves a frozen draft exactly as it found it', () => {
    const before = JSON.stringify(PART_FILLED_DRAFT);

    const completeness = evaluateCompleteness(PART_FILLED_DRAFT);
    const missing = collectMissingItems(deepFreeze(completeness));

    // Every guidance read, over every path the draft raised.
    for (const item of missing.items) {
      fieldGuide(item.path);
      fieldDomId(item.path);
      const guide = fieldGuide(item.path);
      if (guide) requirementLine(guide);
    }
    missingSummaryLabel(missing.total);
    for (const slide of WALKTHROUGH_SLIDES) expect(slide.title).toBeTruthy();
    for (const step of Object.values(STEP_GUIDANCE)) expect(step.intro).toBeTruthy();

    expect(JSON.stringify(PART_FILLED_DRAFT)).toBe(before);
  });

  it('does not change completion, progress or version', () => {
    const first = evaluateCompleteness(PART_FILLED_DRAFT);
    collectMissingItems(first);
    // Reading guidance for every field, as opening an example does.
    for (const path of Object.keys(FIELD_GUIDANCE)) {
      const guide = fieldGuide(path);
      if (guide) requirementLine(guide);
    }
    const second = evaluateCompleteness(PART_FILLED_DRAFT);

    expect(second.complete).toBe(first.complete);
    expect(second.totalIssues).toBe(first.totalIssues);
    expect(second.steps.map((s) => s.complete)).toEqual(first.steps.map((s) => s.complete));
  });

  it('the guidance data itself is never rewritten by reading it', () => {
    const snapshot = JSON.stringify(FIELD_GUIDANCE);
    collectMissingItems(evaluateCompleteness({}));
    for (const path of Object.keys(FIELD_GUIDANCE)) fieldGuide(path);
    expect(JSON.stringify(FIELD_GUIDANCE)).toBe(snapshot);
  });
});
