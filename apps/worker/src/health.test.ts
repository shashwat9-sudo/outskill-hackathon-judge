import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { stalenessLimitMs, startHealthServer, type WorkerHeartbeat } from './health';

/**
 * Worker health.
 *
 * The distinction being tested is the one that matters operationally: a worker
 * deep in a browser run is BUSY and must not be restarted; a worker whose loop
 * has wedged is STALLED and must be.
 */

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

function start(heartbeat: WorkerHeartbeat, stalenessMs = 60_000, now = () => new Date()) {
  // Port 0 asks the OS for a free port, so concurrent test files cannot collide.
  server = startHealthServer({ port: 0, getHeartbeat: () => heartbeat, stalenessMs, now });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

interface ReadyBody {
  status: string;
  quietForSeconds: number;
  inFlight: number;
}

/** `Response.json()` is `unknown`; the shape is this module's own contract. */
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const fresh = (overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat => ({
  lastIterationAt: new Date(),
  inFlight: 0,
  draining: false,
  ...overrides,
});

describe('staleness limit', () => {
  it('outlasts a full browser budget, so a busy worker is never killed', () => {
    const budget = 480_000;
    expect(stalenessLimitMs(2000, budget)).toBeGreaterThan(budget);
  });

  it('never drops below a minute, however short the poll interval', () => {
    expect(stalenessLimitMs(100, 1000)).toBeGreaterThanOrEqual(60_000);
  });
});

describe('liveness', () => {
  it('answers while the process is up', async () => {
    const base = start(fresh());
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('stays up even when the loop has gone quiet', async () => {
    // A worker mid-assessment must not be restarted. That is readiness's job.
    const base = start(fresh({ lastIterationAt: new Date(Date.now() - 3_600_000) }));
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe('readiness', () => {
  it('reports ready while the loop is ticking', async () => {
    const base = start(fresh());
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(200);
    expect((await readJson<ReadyBody>(response)).status).toBe('ok');
  });

  it('reports stalled once the loop stops advancing', async () => {
    const now = new Date('2026-03-13T12:00:00Z');
    const base = start(
      fresh({ lastIterationAt: new Date(now.getTime() - 120_000) }),
      60_000,
      () => now,
    );

    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    const body = await readJson<ReadyBody>(response);
    expect(body.status).toBe('stalled');
    expect(body.quietForSeconds).toBe(120);
  });

  it('reports draining as soon as a signal arrives, before work finishes', async () => {
    // So the platform stops sending work here while in-flight assessments run
    // to completion.
    const base = start(fresh({ draining: true, inFlight: 2 }));
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);

    const body = await readJson<ReadyBody>(response);
    expect(body.status).toBe('draining');
    expect(body.inFlight).toBe(2);
  });

  it('reports seconds, not milliseconds', async () => {
    const now = new Date('2026-03-13T12:00:00Z');
    const base = start(fresh({ lastIterationAt: new Date(now.getTime() - 4321) }), 60_000, () => now);
    const body = await readJson<ReadyBody>(await fetch(`${base}/readyz`));
    expect(body.quietForSeconds).toBe(4);
    expect(JSON.stringify(body)).not.toContain('4321');
  });
});

describe('what it does not expose', () => {
  it('carries no job ids, team identifiers, URLs or configuration', async () => {
    const base = start(fresh({ inFlight: 3 }));
    const body = JSON.stringify(await readJson<ReadyBody>(await fetch(`${base}/readyz`)));

    for (const forbidden of ['http', 'group', 'team', 'submission', 'key', 'token', 'password']) {
      expect(body.toLowerCase(), `readyz leaks ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('404s anything else, rather than serving a directory or a stack trace', async () => {
    const base = start(fresh());
    for (const path of ['/', '/metrics', '/../etc/passwd', '/jobs']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
