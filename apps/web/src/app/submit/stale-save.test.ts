import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A screen that says "complete" must mean the server agrees.
 *
 * From the acceptance run. An operator re-entered declarations that had been
 * lost, watched the form report 6 of 6 steps complete, and reported the
 * recovery done. Nothing had been written: the tab had been open since before
 * another writer bumped the version, so every autosave was refused as a
 * conflict — correctly — and the work stayed in the browser.
 *
 * Two separate facts were being read as one. Completeness is computed from
 * local form state and says nothing about persistence, and they sat next to
 * each other on screen. On deadline night a team could believe their submission
 * is safe when none of it exists.
 *
 * The fix does not weaken optimistic concurrency, which behaved correctly
 * throughout. It stops the interface claiming more than it knows.
 */

const FORM = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '_components/submission-form.tsx',
);
const ACTIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/participant-actions.ts');

const form = () => readFile(FORM, 'utf8');

/** Statements only — a comment describing a rule is not the rule. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the version the client sends', () => {
  it('comes from the server, not from counting local successes', async () => {
    // `versionRef.current += 1` drifts the moment anything else writes, and
    // then every save is refused while the screen still looks healthy.
    const text = code(await form());
    expect(text).toMatch(/versionRef\.current = result\.version \?\?/);
  });

  it('is returned by the save action', async () => {
    const text = code(await readFile(ACTIONS, 'utf8'));
    expect(text).toMatch(/version: result\.submission\?\.version/);
  });
});

describe('a refused save', () => {
  it('marks the work as unsaved', async () => {
    const text = code(await form());
    const conflictBranch = text.slice(text.indexOf('} else if (result.conflict) {'));
    expect(conflictBranch.slice(0, 400)).toMatch(/setUnsaved\(true\)/);
  });

  it('marks the work as unsaved for an ordinary failure too', async () => {
    // A closed window, an ended session, a network error — all leave the work
    // in the browser only.
    const text = code(await form());
    const errorBranch = text.slice(text.indexOf("setSaveError(result.error ?? 'Could not save.')") - 200);
    expect(errorBranch.slice(0, 300)).toMatch(/setUnsaved\(true\)/);
  });

  it('never leaves the indicator reading "saved"', async () => {
    // `setSaveState('saved')` may appear only on the success path.
    const text = code(await form());
    const savedCalls = [...text.matchAll(/setSaveState\('saved'\)/g)];
    expect(savedCalls).toHaveLength(1);

    const successBranch = text.slice(text.indexOf('if (result.ok) {'), text.indexOf('} else if (result.conflict)'));
    expect(successBranch).toContain("setSaveState('saved')");
  });
});

describe('typing', () => {
  it('immediately marks the draft unsaved', async () => {
    // Between a keystroke and a confirmed write, the work exists in one place.
    const text = code(await form());
    const schedule = text.slice(text.indexOf('pendingRef.current = next;'));
    expect(schedule.slice(0, 200)).toMatch(/setUnsaved\(true\)/);
  });

  it('clears the flag only when the server confirms', async () => {
    const text = code(await form());
    const success = text.slice(text.indexOf('if (result.ok) {'), text.indexOf('} else if (result.conflict)'));
    expect(success).toMatch(/setUnsaved\(false\)/);
  });
});

describe('final submission', () => {
  it('is blocked while anything is unsaved or conflicted', async () => {
    const text = code(await form());
    expect(text).toMatch(/disabled=\{confirmation !== FINAL_SUBMIT_CONFIRMATION \|\| conflict \|\| unsaved\}/);
  });

  it('replaces the confirmation box with an explanation, rather than failing silently', async () => {
    // A disabled button with no reason is the same trap in a different shape.
    const text = await form();
    expect(text).toMatch(/conflict \|\| unsaved \?/);
    expect(text).toMatch(/wasn&rsquo;t saved|wasn't saved/i);
    expect(text).toMatch(/still saving/i);
  });

  it('offers a way out of a conflict', async () => {
    const text = await form();
    expect(text).toMatch(/Reload and continue/);
    expect(text).toMatch(/window\.location\.reload\(\)/);
  });

  it('explains that the page is out of date, not that the team did something wrong', async () => {
    // The subject of the sentence is the submission, never the learner. "This
    // submission changed in another tab" is a fact about the world; "you did
    // not save" is an accusation, and an untrue one.
    const text = await form();
    expect(text).toMatch(/This submission changed in another tab/);
    expect(text).toMatch(/Reload to continue safely/);
    expect(text).not.toMatch(/you (did not|didn.t) save|your mistake|error on your/i);
  });
});

describe('what was deliberately not changed', () => {
  it('keeps the optimistic-concurrency check intact', async () => {
    // The conflict detection was right. Only the interface was wrong.
    const text = code(await form());
    expect(text).toMatch(/saveDraftAction\(payload, versionRef\.current\)/);
    expect(text).toMatch(/setConflict\(true\)/);
  });

  it('still stops autosaving into a losing battle', async () => {
    const text = code(await form());
    const conflictBranch = text.slice(text.indexOf('} else if (result.conflict) {'));
    expect(conflictBranch.slice(0, 300)).toMatch(/clearTimeout\(timerRef\.current\)/);
  });
});
