import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the entry flow is allowed to trust.
 *
 * Two steps: prove which team you are, then say who is editing. The security of
 * the whole participant surface rests on the second step being unable to change
 * the answer to the first.
 *
 * Written after an acceptance-run report that group 902 was accepted with group
 * 901's code. That turned out not to be what happened — the database shows
 * group 901's code was never successfully verified — but the report was
 * reasonable, because `/submit` silently redirected an already-signed-in device
 * into its existing portal without ever showing the form. Entering different
 * credentials appeared to be accepted when it had simply been ignored.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBMIT = resolve(HERE, '../app/submit');

const source = (path: string) => readFile(resolve(HERE, path), 'utf8');
const submitSource = (path: string) => readFile(resolve(SUBMIT, path), 'utf8');

/** Statements only — prose about teams is not a binding. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('step one carries only what it verified', () => {
  it('signs the handle with the verified team id, never the submitted group', async () => {
    // The group number is what the caller ASKED for. The team id is what the
    // server PROVED. Only the second may travel forward.
    const text = code(await source('participant-actions.ts'));
    expect(text).toMatch(/signVerificationHandle\(\s*result\.teamId/);
    expect(text).not.toMatch(/signVerificationHandle\(\s*groupNumber/);
  });

  it('passes the submitted group number to verification, so the pair is checked', async () => {
    const text = code(await source('participant-actions.ts'));
    expect(text).toMatch(/verifyTeamAccess\(\{[\s\S]{0,200}groupNumber/);
  });

  it('returns the same generic error for every failure', async () => {
    const text = code(await source('participant-actions.ts'));
    const verifySection = text.slice(
      text.indexOf('export async function verifyTeamAction'),
      text.indexOf('function handleSecret'),
    );
    // Shape failures and store failures both use the shared constant.
    expect(verifySection).toMatch(/GENERIC_VERIFICATION_ERROR/);
    expect(verifySection).not.toMatch(/no such group|group not found|unknown group/i);
  });
});

describe('step two cannot choose a team', () => {
  it('reads the team from the signed handle, not from the form', async () => {
    // If the editor-name step accepted a team id from its own form, anyone who
    // reached step two could type another team's identifier.
    const text = code(await source('participant-actions.ts'));
    const section = text.slice(
      text.indexOf('export async function startEditingAction'),
      text.indexOf('export async function endSessionAction'),
    );

    expect(section).toMatch(/readVerificationHandle|PARTICIPANT_PENDING_COOKIE/);
    expect(section, 'the editor step must not read a team or group from the form').not.toMatch(
      /formData\.get\(['"](teamId|groupNumber|cohortId)['"]\)/,
    );
  });

  it('does not let the client supply a team id anywhere in the entry component', async () => {
    const text = code(await submitSource('team-entry.tsx'));
    expect(text).not.toMatch(/name="teamId"|name="cohortId"/);
  });
});

describe('an already signed-in device', () => {
  it('is told which team it is, rather than being redirected into it', async () => {
    // The behaviour that made a genuine credential test impossible, and that on
    // a shared hackathon laptop would drop one team inside another team's
    // submission with edit rights.
    const text = await submitSource('page.tsx');
    expect(text).toMatch(/already signed in as Group/i);
    expect(text).toMatch(/Sign out to use a different group/i);
  });

  it('no longer redirects straight to the portal', async () => {
    const text = code(await submitSource('page.tsx'));
    expect(text).not.toMatch(/redirect\(['"]\/submit\/portal['"]\)/);
  });

  it('warns that entering a different group will not switch teams', async () => {
    const text = await submitSource('page.tsx');
    expect(text).toMatch(/will not change who you are signed in as/i);
  });

  it('still offers a way through to the portal', async () => {
    // Removing the redirect must not strand a team that is simply returning.
    const text = await submitSource('page.tsx');
    expect(text).toMatch(/\/submit\/portal/);
  });
});
