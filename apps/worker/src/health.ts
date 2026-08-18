/**
 * Worker health endpoint.
 *
 * A worker is a polling loop, not a server, so nothing about it is observable
 * from outside by default. That is fine until the loop wedges — on a database
 * call, on a browser that never closes — and the process keeps running while no
 * job advances. A container platform restarts an unhealthy process; it cannot
 * restart a quiet one.
 *
 * So: liveness is "the process is up", readiness is "the loop ran recently".
 * The distinction matters, because a worker that is merely slow should not be
 * killed mid-assessment.
 */

import { createServer, type Server } from 'node:http';

export interface WorkerHeartbeat {
  /** When the polling loop last completed an iteration. */
  lastIterationAt: Date;
  /** Jobs currently leased by this worker. */
  inFlight: number;
  /** Set when the loop is winding down after a signal. */
  draining: boolean;
}

/**
 * How long the loop may go quiet before readiness fails.
 *
 * Generous relative to the poll interval: an idle worker sleeps for the poll
 * interval between iterations, and a busy one can spend minutes inside a single
 * browser run. Anything shorter would restart healthy workers.
 */
export function stalenessLimitMs(pollIntervalMs: number, browserBudgetMs: number): number {
  return Math.max(pollIntervalMs * 4, browserBudgetMs * 2, 60_000);
}

export interface HealthServerOptions {
  port: number;
  getHeartbeat: () => WorkerHeartbeat;
  stalenessMs: number;
  now?: () => Date;
}

/**
 * Start the health server.
 *
 * Two routes and nothing else. It exposes no job ids, no team identifiers, no
 * product URLs and no configuration — a worker's health surface sits inside the
 * same network as everything else, and there is nothing here worth leaking.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const now = options.now ?? (() => new Date());

  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const respond = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      response.end(payload);
    };

    if (url === '/healthz') {
      // Liveness: the event loop is answering. Deliberately does not consider
      // staleness — a worker deep in a browser run is alive and must not be
      // killed halfway through someone's assessment.
      respond(200, { status: 'ok' });
      return;
    }

    if (url === '/readyz') {
      const heartbeat = options.getHeartbeat();
      const quietForMs = now().getTime() - heartbeat.lastIterationAt.getTime();
      const stale = quietForMs > options.stalenessMs;
      const ready = !stale && !heartbeat.draining;

      respond(ready ? 200 : 503, {
        status: ready ? 'ok' : heartbeat.draining ? 'draining' : 'stalled',
        // Rounded to seconds: milliseconds in an operator-facing readout are
        // noise, and this is read by a human as often as by a probe.
        quietForSeconds: Math.round(quietForMs / 1000),
        inFlight: heartbeat.inFlight,
      });
      return;
    }

    respond(404, { status: 'not_found' });
  });

  server.listen(options.port);
  // The health server must never be the reason the process stays alive: when
  // the loop stops, the container should exit.
  server.unref();
  return server;
}
