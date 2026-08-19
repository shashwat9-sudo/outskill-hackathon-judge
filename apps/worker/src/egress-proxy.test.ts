import { createServer, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEgressProxy, egressProxyArgs, type EgressProxy } from './egress-proxy';

/**
 * Everything the browser is not allowed to reach.
 *
 * The application already validates a URL before navigating. That check is
 * necessary and it is not sufficient, because validating and connecting are two
 * separate events and the answer can change in between: whoever operates a
 * hostname decides what it resolves to next, and we point a browser at
 * hostnames strangers gave us. A pre-flight lookup cannot close that, because
 * the lookup that decides where the packets go is the one the browser performs.
 *
 * So these tests are about the proxy, which is the layer where the browser does
 * not get to perform one. Most of them are attacks. The one that matters most
 * is `rebinding`, because it is the case a pre-navigation check passes and a
 * connection still ends up somewhere private.
 */

let proxy: EgressProxy;
let origin: Server;
let originPort: number;

/** A resolver we control, so rebinding can be staged precisely. */
let answers: Record<string, string[]> = {};
let lookups: string[] = [];

const resolver = async (hostname: string) => {
  lookups.push(hostname);
  const answer = answers[hostname];
  if (!answer) throw new Error(`no such host: ${hostname}`);
  return answer;
};

beforeAll(async () => {
  origin = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('origin ok'));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
});

afterEach(async () => {
  await proxy?.close();
  answers = {};
  lookups = [];
});

/** Ask the proxy for a plain-HTTP URL, the way a browser would. */
function through(url: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: target.host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open a CONNECT tunnel, the way HTTPS and WebSockets do. */
function tunnel(hostPort: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
}

describe('addresses the browser must never reach', () => {
  beforeAll(() => {});

  it('refuses loopback, in every spelling', async () => {
    proxy = await createEgressProxy({ resolver });
    for (const host of ['127.0.0.1', '127.1.2.3', '[::1]']) {
      const { status } = await through(`http://${host}/`);
      expect(status, host).toBe(403);
    }
  });

  it('refuses a hostname that resolves to loopback', async () => {
    // The classic: the name is fine, the answer is not.
    answers['localtest.me'] = ['127.0.0.1'];
    proxy = await createEgressProxy({ resolver });
    expect((await through('http://localtest.me/')).status).toBe(403);
  });

  it('refuses every RFC1918 range', async () => {
    proxy = await createEgressProxy({ resolver });
    for (const host of ['10.0.0.5', '172.16.4.4', '172.31.255.1', '192.168.1.1']) {
      expect((await through(`http://${host}/`)).status, host).toBe(403);
    }
  });

  it('refuses link-local and the metadata endpoint', async () => {
    /*
     * 169.254.169.254 is the one that turns an SSRF into a credential leak on
     * most clouds. It is link-local, so it would be refused anyway; it is called
     * out separately because it is the address an attacker actually wants.
     */
    proxy = await createEgressProxy({ resolver });
    for (const host of ['169.254.0.1', '169.254.169.254']) {
      expect((await through(`http://${host}/`)).status, host).toBe(403);
    }
  });

  it('refuses carrier-grade NAT and unspecified addresses', async () => {
    proxy = await createEgressProxy({ resolver });
    for (const host of ['100.64.0.1', '0.0.0.0']) {
      expect((await through(`http://${host}/`)).status, host).toBe(403);
    }
  });

  it('refuses private and link-local IPv6', async () => {
    proxy = await createEgressProxy({ resolver });
    for (const host of ['[fd00::1]', '[fe80::1]', '[::]']) {
      expect((await through(`http://${host}/`)).status, host).toBe(403);
    }
  });

  it('refuses an IPv4-mapped IPv6 address pointing at loopback', async () => {
    // ::ffff:127.0.0.1 is loopback wearing an IPv6 costume.
    proxy = await createEgressProxy({ resolver });
    expect((await through('http://[::ffff:127.0.0.1]/')).status).toBe(403);
  });

  it('refuses unusual numeric encodings rather than interpreting them', async () => {
    /*
     * `2130706433` is 127.0.0.1 as a single integer, and `0177.0.0.1` is the
     * same in octal. Different stacks parse these differently, which is exactly
     * why we do not try: a host that looks like a number and is not an address
     * we recognise is refused.
     */
    proxy = await createEgressProxy({ resolver });
    for (const host of ['2130706433', '0177.0.0.1', '127.1', '192.168.1']) {
      expect((await through(`http://${host}/`)).status, host).toBe(403);
      expect(lookups, `${host} should never reach the resolver`).not.toContain(host);
    }
  });
});

describe('DNS rebinding', () => {
  it('cannot switch a public name to a private address after validation', async () => {
    /*
     * The attack this whole file exists for.
     *
     * The name answers public the first time — passing any pre-navigation check
     * — and private on every lookup after. A browser resolving for itself would
     * connect to the second answer. Here the browser never resolves: the proxy
     * does, and connects to the address it just classified.
     */
    let call = 0;
    proxy = await createEgressProxy({
      resolver: async (hostname) => {
        lookups.push(hostname);
        call += 1;
        return call === 1 ? ['93.184.216.34'] : ['169.254.169.254'];
      },
    });

    // The first request is allowed through (its answer was public) and never
    // completes, because nothing is listening there — which is fine: what this
    // asserts is the verdict, not the response.
    await through('http://rebind.test/').catch(() => undefined);
    expect(proxy.decisions[0]?.allowed).toBe(true);

    // The name now answers private. It is resolved again, and refused.
    const second = await through('http://rebind.test/');
    expect(second.status).toBe(403);
    expect(proxy.decisions.at(-1)?.allowed).toBe(false);
    expect(lookups.filter((l) => l === 'rebind.test').length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('refuses a name answering with a public and a private address together', async () => {
    // Racing the two is not a decision we get to make on a learner's behalf.
    answers['split.test'] = ['93.184.216.34', '10.0.0.1'];
    proxy = await createEgressProxy({ resolver });
    expect((await through('http://split.test/')).status).toBe(403);
  });

  it('connects to the address it validated, not to the name', async () => {
    /*
     * The structural reason rebinding fails: there is no second resolution to
     * poison. One lookup happens, and the socket is opened to its answer.
     */
    answers['fixture.test'] = ['127.0.0.1'];
    proxy = await createEgressProxy({ resolver, allowLoopbackForTesting: true });

    const res = await through(`http://fixture.test:${originPort}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('origin ok');
    expect(lookups.filter((l) => l === 'fixture.test')).toHaveLength(1);
    expect(proxy.decisions.at(-1)?.address).toBe('127.0.0.1');
  });
});

describe('redirects and subresources', () => {
  it('revalidates a redirect, because it arrives as its own request', async () => {
    /*
     * A redirect is not special. The browser follows it by making a new request
     * through the proxy, so a public page redirecting to 169.254.169.254 is
     * refused at the second hop with no extra machinery.
     */
    answers['public.test'] = ['93.184.216.34'];
    proxy = await createEgressProxy({ resolver });

    expect((await through('http://169.254.169.254/latest/meta-data/')).status).toBe(403);
  });

  it('applies the same rule to a subresource as to a navigation', async () => {
    // Every image, script and font is a request through this proxy. There is no
    // separate path for them to slip down.
    proxy = await createEgressProxy({ resolver });
    for (const host of ['10.1.2.3', '192.168.0.9', '[::1]']) {
      expect((await through(`http://${host}/asset.js`)).status, host).toBe(403);
    }
  });
});

describe('CONNECT: HTTPS and WebSockets', () => {
  it('refuses a private destination', async () => {
    // wss:// and https:// both open with CONNECT, so both are covered here.
    proxy = await createEgressProxy({ resolver });
    for (const target of ['127.0.0.1:443', '169.254.169.254:443', '10.0.0.1:443', '[::1]:443']) {
      expect(await tunnel(target), target).toBe(403);
    }
  });

  it('refuses a name that resolves somewhere private', async () => {
    answers['ws.test'] = ['192.168.5.5'];
    proxy = await createEgressProxy({ resolver });
    expect(await tunnel('ws.test:443')).toBe(403);
  });

  it('establishes a tunnel to a permitted destination', async () => {
    answers['fixture.test'] = ['127.0.0.1'];
    proxy = await createEgressProxy({ resolver, allowLoopbackForTesting: true });
    expect(await tunnel(`fixture.test:${originPort}`)).toBe(200);
  });
});

describe('failing closed', () => {
  it('refuses when the name cannot be resolved', async () => {
    proxy = await createEgressProxy({ resolver });
    expect((await through('http://nonexistent.invalid/')).status).toBe(403);
  });

  it('refuses when a name resolves to nothing at all', async () => {
    answers['empty.test'] = [];
    proxy = await createEgressProxy({ resolver });
    expect((await through('http://empty.test/')).status).toBe(403);
  });

  it('refuses ports a browser has no business using', async () => {
    // 22, 25 and 6379 are not places a product's front end lives, and a browser
    // reaching them is a request nobody made on purpose.
    answers['public.test'] = ['93.184.216.34'];
    proxy = await createEgressProxy({ resolver });
    for (const port of [22, 25, 3306, 5432, 6379, 11211]) {
      expect(await tunnel(`public.test:${port}`), String(port)).toBe(403);
    }
  });

  it('records every decision, so a run can be audited afterwards', async () => {
    answers['public.test'] = ['93.184.216.34'];
    proxy = await createEgressProxy({ resolver });
    await through('http://10.0.0.1/');

    const last = proxy.decisions.at(-1)!;
    expect(last.allowed).toBe(false);
    expect(last.host).toBe('10.0.0.1');
    expect(last.reason).toMatch(/private/i);
  });
});

describe('a normal public target', () => {
  it('is allowed, because a boundary that blocks everything is not a boundary', async () => {
    answers['fixture.test'] = ['127.0.0.1'];
    proxy = await createEgressProxy({ resolver, allowLoopbackForTesting: true });

    const res = await through(`http://fixture.test:${originPort}/`);
    expect(res.status).toBe(200);
    expect(proxy.decisions.at(-1)?.allowed).toBe(true);
  });
});

describe('the flags Chromium is given', () => {
  it('points the browser at the proxy and removes the loopback bypass', async () => {
    /*
     * `--proxy-bypass-list=<-loopback>` is the easiest thing here to leave out
     * and the most damaging: Chromium bypasses a proxy for loopback by default,
     * so without it `http://127.0.0.1` would go direct and never reach a single
     * check in this file.
     */
    proxy = await createEgressProxy({ resolver });
    const args = egressProxyArgs(proxy);

    expect(args).toContain(`--proxy-server=${proxy.proxyUrl}`);
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
  });
});
