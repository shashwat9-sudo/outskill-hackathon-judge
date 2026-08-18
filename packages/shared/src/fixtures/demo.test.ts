import { describe, expect, it } from 'vitest';
import {
  DEMO_COHORT,
  DEMO_DAY12_START,
  DEMO_DEADLINE,
  DEMO_NOW,
  DEMO_SCENARIO_META,
  DEMO_SHORTLIST_DUE,
  DEMO_TEAMS,
  demoTeamId,
} from './demo';
import { MemoryDataStore } from '../data/memory/store';
import { asDemoStore } from '../data/store';
import { evaluateDeadline, evaluateShortlistWindow } from '../domain/deadline';
import { canParticipantEdit } from '../domain/status';

/**
 * Demo fixture guarantees.
 *
 * A demo that opens with an expired deadline, or with no invite links, is worse
 * than no demo — it teaches the operator the wrong thing about the product.
 */

describe('demo dates are never expired', () => {
  it('places the submission deadline in the future', () => {
    expect(DEMO_DEADLINE.getTime()).toBeGreaterThan(DEMO_NOW.getTime());
  });

  it('places the Day 12 start at or before now, so the cohort is already running', () => {
    // Held at every hour of the day, not just after 09:00 IST. Before that the
    // naive "today at 09:00" boundary sits in the future and the whole demo is
    // read-only — nine hours a night of teaching the wrong thing.
    expect(DEMO_DAY12_START.getTime()).toBeLessThanOrEqual(DEMO_NOW.getTime());
  });

  it('opens the window strictly before it closes', () => {
    expect(DEMO_DAY12_START.getTime()).toBeLessThan(DEMO_DEADLINE.getTime());
  });

  it('places the shortlist deadline after the submission deadline', () => {
    expect(DEMO_SHORTLIST_DUE.getTime()).toBeGreaterThan(DEMO_DEADLINE.getTime());
  });

  it('does not report a passed deadline', () => {
    const evaluation = evaluateDeadline(DEMO_DEADLINE);
    expect(evaluation.hasPassed).toBe(false);
    expect(evaluation.isLate).toBe(false);
  });

  it('does not open with a shortlist-overdue warning', () => {
    const window = evaluateShortlistWindow(DEMO_DEADLINE, null);
    expect(window.onTrack).toBe(true);
    expect(window.label).not.toMatch(/passed|behind/i);
  });

  it('freezes the clock for the process, so timestamps do not drift mid-session', async () => {
    const first = DEMO_NOW.getTime();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { DEMO_NOW: second } = await import('./demo');
    expect(second.getTime()).toBe(first);
  });
});

describe('demo cohort is explorable', () => {
  it('ships open, so the learner journey works without an operator changing anything', () => {
    expect(DEMO_COHORT.status).toBe('open');
    expect(canParticipantEdit(DEMO_COHORT.status, 'draft')).toBe(true);
  });

  it('still locks a submitted entry', () => {
    expect(canParticipantEdit(DEMO_COHORT.status, 'locked')).toBe(false);
  });
});

describe('demo scenarios', () => {
  it('covers the six situations an operator needs to recognise', () => {
    expect(DEMO_TEAMS).toHaveLength(6);
    expect(DEMO_TEAMS.map((t) => t.scenario).sort()).toEqual([
      'complete',
      'inaccessible',
      'incomplete',
      'login_required',
      'low_confidence',
      'manual_review',
    ]);
  });

  it('gives every scenario a label and a plain-language summary', () => {
    for (const team of DEMO_TEAMS) {
      const meta = DEMO_SCENARIO_META[team.scenario];
      expect(meta, team.scenario).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(3);
      expect(meta.summary.length).toBeGreaterThan(20);
    }
  });
});

describe('demo invite links survive module reloading', () => {
  it('exposes the demo capability through the interface, not through a class check', () => {
    const store = new MemoryDataStore();
    const demo = asDemoStore(store);

    // This is the regression: `store instanceof MemoryDataStore` returned false
    // after a hot reload because the class object differed, silently emptying
    // the home page. Feature detection cannot fail that way.
    expect(demo).not.toBeNull();
    expect(typeof demo?.getDemoInviteToken).toBe('function');
    expect(typeof demo?.listDemoInvites).toBe('function');
  });

  it('returns a usable token for all six demo teams', async () => {
    const store = new MemoryDataStore();
    await store.whenReady();
    const demo = asDemoStore(store);

    for (const team of DEMO_TEAMS) {
      const token = demo?.getDemoInviteToken(demoTeamId(team.groupNumber));
      expect(token, `group ${team.groupNumber} has no invite token`).toBeTruthy();

      // Every token must actually mint a session for that team.
      const session = await store.participant.redeemInviteToken(token as string, {
        name: 'Demo editor',
        role: null,
      });
      expect(session, `group ${team.groupNumber} token does not resolve`).not.toBeNull();

      const view = await store.participant.resolveSession(session?.token as string);
      expect(view?.team.groupNumber).toBe(team.groupNumber);
    }
  });

  it('exposes a working access code for every demo team', async () => {
    const store = new MemoryDataStore();
    await store.whenReady();

    for (const team of DEMO_TEAMS) {
      const result = await store.participant.verifyTeamAccess({
        groupNumber: team.groupNumber,
        code: store.getDemoAccessCode(team.groupNumber),
        ipHash: `ip-${team.groupNumber}`,
      });
      expect(result.ok, `group ${team.groupNumber} code does not verify`).toBe(true);
    }
  });

  it('lists six invites', () => {
    const store = new MemoryDataStore();
    expect(asDemoStore(store)?.listDemoInvites()).toHaveLength(6);
  });

  it('reports no demo capability for a non-memory driver', () => {
    const fake = { driver: 'postgres' } as never;
    expect(asDemoStore(fake)).toBeNull();
  });
});
