import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { classifyAddress, type AddressClassification } from '@ohj/shared';

/**
 * The only way out of the browser.
 *
 * Validating a URL before navigating is not enough, and the reason is worth
 * stating plainly: the check and the connection are two separate events, and
 * between them the answer can change. A hostname that resolved to a public
 * address when we looked can resolve to 169.254.169.254 when Chromium looks a
 * moment later — the operator of the name chooses, and on a hackathon we are
 * pointing a browser at URLs strangers gave us. That is DNS rebinding, and no
 * amount of pre-flight lookup closes it, because the lookup that matters is the
 * one the browser performs.
 *
 * So the browser is not allowed to perform one. Chromium is started with
 * `--proxy-server` pointing here, and a browser configured with an HTTP proxy
 * does not resolve hostnames at all: it hands the name to the proxy and asks it
 * to make the connection. Every request goes through this file — the first
 * navigation, every redirect, every image, script and font, and every
 * WebSocket, because those open with CONNECT too.
 *
 * Here the sequence is single-threaded and unforgeable:
 *
 *   resolve the name ourselves → classify every address it returned →
 *   refuse unless all of them are public → open the socket to the address we
 *   validated, never to the name.
 *
 * The last step is what makes rebinding pointless. Nothing re-resolves between
 * the check and the connection, because the connection is made to an IP that
 * has already been checked. A name that returns one public and one private
 * address is refused outright rather than raced.
 *
 * Fail-closed throughout: a resolution error, an unparseable address, a form we
 * do not recognise, or an internal fault all end the connection. The cost of
 * being wrong in the permissive direction is a learner's browser reading our
 * database credentials out of a metadata endpoint.
 */

export interface EgressProxyOptions {
  /** Swappable for tests. Defaults to the system resolver. */
  resolver?: (hostname: string) => Promise<string[]>;
  /**
   * TEST ONLY. Permits loopback destinations so the suite can drive the local
   * fixture app through the proxy. Never set in the worker — asserted by
   * `worker-security.test.ts`.
   */
  allowLoopbackForTesting?: boolean;
  /** Called for every decision, so a run can be audited afterwards. */
  onDecision?: (decision: EgressDecision) => void;
}

export interface EgressDecision {
  host: string;
  port: number;
  allowed: boolean;
  /** The address actually connected to, when allowed. */
  address?: string;
  reason?: string;
  code?: AddressClassification['code'];
}

export interface EgressProxy {
  readonly port: number;
  /** What Chromium should be given as `--proxy-server`. */
  readonly proxyUrl: string;
  readonly decisions: EgressDecision[];
  close(): Promise<void>;
}

/** How long an unresponsive destination may hold a request open. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 8000;

/** Ports a browser has any business reaching. */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443, 3000]);

async function systemResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * May the browser reach this host, and at which address?
 *
 * Returns the single address to connect to. Every address the name resolved to
 * must be safe: a name that answers with one public and one private address is
 * refused rather than raced, because which one a later lookup would return is
 * not ours to decide.
 */
async function decide(
  host: string,
  port: number,
  resolver: (hostname: string) => Promise<string[]>,
  allowLoopback: boolean,
): Promise<{ ok: true; address: string } | { ok: false; reason: string; code?: AddressClassification['code'] }> {
  // The port allow-list is skipped only under the test escape hatch, so the
  // suite can drive a fixture app listening on an ephemeral port.
  if (!allowLoopback && !ALLOWED_PORTS.has(port)) {
    return { ok: false, reason: `Port ${port} is not permitted.` };
  }

  const bare = host.replace(/^\[|\]$/g, '');

  /*
   * Is this an address rather than a name?
   *
   * Anything containing a colon is IPv6. Anything made only of digits and dots
   * is claiming to be IPv4 — including the forms that exist to slip past a
   * naive check: `2130706433`, `0177.0.0.1`, `127.1`. Those are not handed to
   * the resolver in the hope that it fails; they are refused here, because a
   * host that looks like a number and is not a valid address is not something
   * we should be interpreting on a stranger's behalf.
   */
  const looksNumeric = /^[0-9.]+$/.test(bare);
  const isLiteral = bare.includes(':') || looksNumeric;

  if (isLiteral) {
    const literal = classifyAddress(bare);
    if (!literal.safe && !(allowLoopback && literal.code === 'loopback_address')) {
      const unusual = looksNumeric && literal.code === 'malformed';
      return {
        ok: false,
        reason: unusual
          ? `${bare} is not a valid address in a form we accept.`
          : (literal.reason ?? 'Address is not permitted.'),
        code: literal.code,
      };
    }
    return { ok: true, address: bare };
  }

  let addresses: string[];
  try {
    addresses = await resolver(bare);
  } catch {
    // Fail closed: a name we cannot resolve is a name we cannot vouch for.
    return { ok: false, reason: `Could not resolve ${bare}.` };
  }

  if (addresses.length === 0) return { ok: false, reason: `${bare} resolved to nothing.` };

  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (!classification.safe && !(allowLoopback && classification.code === 'loopback_address')) {
      return {
        ok: false,
        reason: `${bare} resolves to ${address}: ${classification.reason}`,
        code: classification.code,
      };
    }
  }

  // Connect to what was checked, not to the name. Nothing resolves again.
  return { ok: true, address: addresses[0]! };
}

export async function createEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const resolver = options.resolver ?? systemResolver;
  const allowLoopback = options.allowLoopbackForTesting === true;
  const decisions: EgressDecision[] = [];

  const record = (d: EgressDecision) => {
    decisions.push(d);
    options.onDecision?.(d);
  };

  const server: Server = createServer();

  /*
   * Plain HTTP. The browser sends an absolute URI and we forward it to the
   * validated address, keeping the Host header so the origin still sees the
   * name it was asked for.
   */
  server.on('request', async (req: IncomingMessage, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Malformed request.');
      return;
    }

    const port = Number(target.port || 80);
    const verdict = await decide(target.hostname, port, resolver, allowLoopback);
    record({ host: target.hostname, port, allowed: verdict.ok, ...(verdict.ok ? { address: verdict.address } : { reason: verdict.reason, code: verdict.code }) });

    if (!verdict.ok) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by egress policy.');
      return;
    }

    const upstream = httpRequest(
      {
        host: verdict.address,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  /*
   * CONNECT — HTTPS, and WebSockets, which open the same way.
   *
   * Once the tunnel is established we are moving opaque bytes, so the only
   * moment control exists is right here, before the socket is opened. That is
   * precisely why the destination is an address we have already classified: the
   * browser performs TLS with its own SNI over a connection whose endpoint it
   * did not choose.
   */
  server.on('connect', async (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const [rawHost, rawPort] = String(req.url ?? '').split(/:(?=\d+$)/);
    const port = Number(rawPort ?? 443);
    const host = rawHost ?? '';

    const verdict = await decide(host, port, resolver, allowLoopback);
    record({ host, port, allowed: verdict.ok, ...(verdict.ok ? { address: verdict.address } : { reason: verdict.reason, code: verdict.code }) });

    if (!verdict.ok) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    /*
     * A destination that accepts the socket and then says nothing would
     * otherwise hold the tunnel — and the browser behind it — indefinitely. The
     * browser has its own budget, but the proxy should not be the thing that
     * makes a run hang.
     */
    const upstream = netConnect(port, verdict.address, () => {
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS);

    const shutdown = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('timeout', () => {
      clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      shutdown();
    });
    upstream.on('error', shutdown);
    clientSocket.on('error', shutdown);
  });

  // Anything the server itself cannot handle ends the connection rather than
  // leaving it half-open in an unknown state.
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    proxyUrl: `http://127.0.0.1:${port}`,
    decisions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * The Chromium flags that make the proxy inescapable.
 *
 * `--proxy-bypass-list=<-loopback>` is the one that is easy to miss and
 * essential: Chromium bypasses a proxy for loopback destinations by default, so
 * without it `http://127.0.0.1` would go direct and never reach any of the
 * checks above. The angle-bracket form is Chromium's syntax for "do not apply
 * the implicit loopback bypass".
 */
export function egressProxyArgs(proxy: EgressProxy): string[] {
  return [`--proxy-server=${proxy.proxyUrl}`, '--proxy-bypass-list=<-loopback>'];
}
