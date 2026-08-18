import { describe, expect, it } from 'vitest';
import {
  STALE_WRITE_MESSAGE,
  TEAM_ACTIVITY_KINDS,
  TEAM_ACTIVITY_LABELS,
  checkVersion,
  describeActivity,
  relativeTime,
} from './concurrency';

/**
 * Several teammates hold the same access code and can edit at the same time.
 * The failure this prevents is specific: someone's work vanishing without anyone
 * noticing, minutes before a deadline.
 */

describe('version checking', () => {
  it('accepts a write from a client holding the current version', () => {
    expect(checkVersion({ expectedVersion: 4, currentVersion: 4 })).toEqual({
      ok: true,
      nextVersion: 5,
    });
  });

  it('refuses a stale write and reports what to reload to', () => {
    const outcome = checkVersion({ expectedVersion: 3, currentVersion: 5 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.currentVersion).toBe(5);
    expect(outcome.message).toBe(STALE_WRITE_MESSAGE);
  });

  it('refuses a write claiming a version from the future', () => {
    // Not a real client, but accepting it would let a crafted request write over
    // whatever it liked.
    expect(checkVersion({ expectedVersion: 99, currentVersion: 5 }).ok).toBe(false);
  });

  it('refuses an unversioned write', () => {
    // A client that never read a version is exactly the silent overwrite this
    // exists to prevent.
    for (const expectedVersion of [-1, 1.5, Number.NaN, Infinity]) {
      expect(checkVersion({ expectedVersion, currentVersion: 2 }).ok, String(expectedVersion)).toBe(
        false,
      );
    }
  });

  it('tells the team what happened and what to do', () => {
    expect(STALE_WRITE_MESSAGE).toMatch(/another team member/i);
    expect(STALE_WRITE_MESSAGE).toMatch(/latest version/i);
    // No version numbers, no "conflict", no HTTP status.
    expect(STALE_WRITE_MESSAGE).not.toMatch(/409|conflict|version \d/i);
  });

  it('advances one step at a time, so two concurrent writers cannot both win', () => {
    let stored = 1;
    // Both clients read version 1.
    const first = checkVersion({ expectedVersion: 1, currentVersion: stored });
    expect(first.ok).toBe(true);
    if (first.ok) stored = first.nextVersion;

    const second = checkVersion({ expectedVersion: 1, currentVersion: stored });
    expect(second.ok).toBe(false);
  });
});

describe('team activity', () => {
  it('labels every kind it declares', () => {
    for (const kind of TEAM_ACTIVITY_KINDS) {
      expect(TEAM_ACTIVITY_LABELS[kind], kind).toBeTruthy();
    }
    expect(Object.keys(TEAM_ACTIVITY_LABELS).sort()).toEqual([...TEAM_ACTIVITY_KINDS].sort());
  });

  it('stays a small learner-safe set', () => {
    // The internal audit log carries score overrides, credential reveals and
    // disqualification steps. None of that may leak into a learner-facing panel
    // by someone adding a kind here.
    const asText = TEAM_ACTIVITY_KINDS.join(' ') + Object.values(TEAM_ACTIVITY_LABELS).join(' ');
    expect(asText).not.toMatch(/score|rank|judg|shortlist|disqualif|credential|reveal/i);
  });

  it('reads as a sentence a person would write', () => {
    const line = describeActivity(
      {
        kind: 'section_saved',
        editorName: 'Priya',
        section: 'Product overview',
        at: new Date('2026-03-13T09:00:00Z'),
      },
      new Date('2026-03-13T09:12:00Z'),
    );
    expect(line).toBe('Priya saved a section — Product overview, 12 minutes ago');
  });

  it('omits the section when there is not one', () => {
    const line = describeActivity(
      {
        kind: 'final_submitted',
        editorName: 'Arjun',
        section: null,
        at: new Date('2026-03-13T09:00:00Z'),
      },
      new Date('2026-03-13T09:00:10Z'),
    );
    expect(line).toBe('Arjun made the final submission, just now');
  });
});

describe('relative time', () => {
  const now = new Date('2026-03-13T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('reads naturally at each scale', () => {
    expect(relativeTime(ago(5_000), now)).toBe('just now');
    expect(relativeTime(ago(60_000), now)).toBe('1 minute ago');
    expect(relativeTime(ago(12 * 60_000), now)).toBe('12 minutes ago');
    expect(relativeTime(ago(60 * 60_000), now)).toBe('1 hour ago');
    expect(relativeTime(ago(3 * 60 * 60_000), now)).toBe('3 hours ago');
    expect(relativeTime(ago(26 * 60 * 60_000), now)).toBe('1 day ago');
    expect(relativeTime(ago(50 * 60 * 60_000), now)).toBe('2 days ago');
  });

  it('never says a teammate edited in the future', () => {
    // Clock skew between a server write and a render must not produce
    // "-3 minutes ago".
    expect(relativeTime(new Date(now.getTime() + 60_000), now)).toBe('just now');
  });

  it('reports no milliseconds anywhere', () => {
    for (const ms of [1000, 60_000, 3_600_000, 86_400_000]) {
      expect(relativeTime(ago(ms), now)).not.toMatch(/\d{4,}|ms\b/);
    }
  });
});
