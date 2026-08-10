/**
 * URL validation and SSRF containment.
 *
 * The worker deliberately visits URLs chosen by the people being judged, so
 * this module is the boundary between "a submission" and "our infrastructure".
 *
 * Two layers:
 *   1. `validateProductUrl` — syntactic checks, safe to run in a web request.
 *      Catches the common honest mistakes (Drive folders, http://, typos).
 *   2. `assertResolvedAddressesSafe` — checks the addresses a hostname actually
 *      resolves to. Only this layer stops a hostname that points at 127.0.0.1.
 *
 * Layer 2 requires DNS and therefore lives behind an injected resolver, so this
 * module stays dependency-free and testable.
 */

export type UrlRejectionCode =
  | 'empty'
  | 'malformed'
  | 'scheme_not_http'
  | 'scheme_not_https'
  | 'credentials_in_url'
  | 'blocked_host'
  | 'private_address'
  | 'loopback_address'
  | 'link_local_address'
  | 'cloud_metadata'
  | 'port_not_allowed'
  | 'host_missing';

export interface UrlValidationResult {
  ok: boolean;
  code?: UrlRejectionCode;
  message?: string;
  /** Present when ok — the normalised URL that should be stored and used. */
  normalised?: string;
  /** Non-blocking observations for admins (e.g. "this looks like a Drive folder"). */
  warnings: UrlWarning[];
}

export interface UrlWarning {
  code: 'document_host' | 'video_host' | 'nonstandard_port' | 'ip_literal' | 'localhost_name';
  message: string;
}

/**
 * Hosts that serve documents or files rather than web applications. A product
 * URL pointing here is almost always the historical "Drive folder instead of an
 * app" mistake. Warned, not blocked — an admin decides.
 */
const DOCUMENT_HOSTS = [
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
  'www.dropbox.com',
  'onedrive.live.com',
  '1drv.ms',
  'sharepoint.com',
  'notion.so',
  'www.notion.so',
];

/** Video hosts — valid for a demo link, wrong for a product URL. */
const VIDEO_HOSTS = [
  'loom.com',
  'www.loom.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'vimeo.com',
  'www.vimeo.com',
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** Ports we allow for a public web application. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443', '3000']);

// --------------------------------------------------------------------------
// Address classification
// --------------------------------------------------------------------------

export interface AddressClassification {
  safe: boolean;
  code?: UrlRejectionCode;
  reason?: string;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

export function classifyIpv4(address: string): AddressClassification {
  const octets = parseIpv4(address);
  if (!octets) return { safe: false, code: 'malformed', reason: `Not an IPv4 address: ${address}` };
  const [a = 0, b = 0, c = 0, d = 0] = octets;

  if (a === 127) return { safe: false, code: 'loopback_address', reason: 'IPv4 loopback (127.0.0.0/8)' };
  if (a === 0) return { safe: false, code: 'private_address', reason: 'Unspecified address (0.0.0.0/8)' };
  if (a === 10) return { safe: false, code: 'private_address', reason: 'Private range 10.0.0.0/8' };
  if (a === 172 && b >= 16 && b <= 31)
    return { safe: false, code: 'private_address', reason: 'Private range 172.16.0.0/12' };
  if (a === 192 && b === 168)
    return { safe: false, code: 'private_address', reason: 'Private range 192.168.0.0/16' };
  if (a === 169 && b === 254) {
    if (c === 169 && d === 254)
      return { safe: false, code: 'cloud_metadata', reason: 'Cloud metadata endpoint 169.254.169.254' };
    return { safe: false, code: 'link_local_address', reason: 'Link-local range 169.254.0.0/16' };
  }
  if (a === 100 && b >= 64 && b <= 127)
    return { safe: false, code: 'private_address', reason: 'Carrier-grade NAT 100.64.0.0/10' };
  if (a === 192 && b === 0 && c === 0)
    return { safe: false, code: 'private_address', reason: 'IETF protocol assignments 192.0.0.0/24' };
  if (a === 192 && b === 0 && c === 2)
    return { safe: false, code: 'private_address', reason: 'Documentation range 192.0.2.0/24' };
  if (a === 198 && (b === 18 || b === 19))
    return { safe: false, code: 'private_address', reason: 'Benchmark range 198.18.0.0/15' };
  if (a >= 224)
    return { safe: false, code: 'private_address', reason: 'Multicast or reserved (224.0.0.0/3)' };

  return { safe: true };
}

export function classifyIpv6(address: string): AddressClassification {
  const raw = address.replace(/^\[|\]$/g, '').toLowerCase();
  const withoutZone = raw.split('%')[0] ?? raw;

  if (withoutZone === '::1')
    return { safe: false, code: 'loopback_address', reason: 'IPv6 loopback (::1)' };
  if (withoutZone === '::' || withoutZone === '::0')
    return { safe: false, code: 'private_address', reason: 'Unspecified IPv6 address' };

  // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1 must not slip through.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(withoutZone);
  if (mapped?.[1]) return classifyIpv4(mapped[1]);

  const firstGroup = withoutZone.split(':')[0] ?? '';
  const prefix = parseInt(firstGroup.padEnd(4, '0'), 16);
  if (Number.isNaN(prefix)) return { safe: true };

  // fc00::/7 unique-local
  if ((prefix & 0xfe00) === 0xfc00)
    return { safe: false, code: 'private_address', reason: 'IPv6 unique-local (fc00::/7)' };
  // fe80::/10 link-local
  if ((prefix & 0xffc0) === 0xfe80)
    return { safe: false, code: 'link_local_address', reason: 'IPv6 link-local (fe80::/10)' };
  // ff00::/8 multicast
  if ((prefix & 0xff00) === 0xff00)
    return { safe: false, code: 'private_address', reason: 'IPv6 multicast (ff00::/8)' };

  return { safe: true };
}

export function classifyAddress(address: string): AddressClassification {
  if (address.includes(':')) return classifyIpv6(address);
  return classifyIpv4(address);
}

function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || hostname.includes(':');
}

// --------------------------------------------------------------------------
// URL validation
// --------------------------------------------------------------------------

export interface ValidateUrlOptions {
  /** Product entry URLs must be HTTPS. Demo/video links may allow HTTP. */
  requireHttps?: boolean;
  /** Warn (rather than stay silent) when the host looks like a document store. */
  flagDocumentHosts?: boolean;
  /** Warn when the host is a video platform — wrong for a product URL. */
  flagVideoHosts?: boolean;
}

export function validateUrl(input: string, options: ValidateUrlOptions = {}): UrlValidationResult {
  const { requireHttps = true, flagDocumentHosts = false, flagVideoHosts = false } = options;
  const warnings: UrlWarning[] = [];

  const trimmed = input?.trim() ?? '';
  if (trimmed.length === 0) {
    return { ok: false, code: 'empty', message: 'URL is required.', warnings };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: 'malformed',
      message: 'This is not a valid URL. Include the full address, starting with https://',
      warnings,
    };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return {
      ok: false,
      code: 'scheme_not_http',
      message: `Only http and https addresses are allowed. "${url.protocol.replace(':', '')}" is not.`,
      warnings,
    };
  }
  if (requireHttps && scheme !== 'https:') {
    return {
      ok: false,
      code: 'scheme_not_https',
      message: 'The product URL must use https:// so it can be tested securely.',
      warnings,
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      code: 'credentials_in_url',
      message:
        'Remove the username or password from the URL. Enter demo credentials in the dedicated fields, where they are encrypted.',
      warnings,
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    return { ok: false, code: 'host_missing', message: 'The URL has no host.', warnings };
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return {
      ok: false,
      code: 'blocked_host',
      message:
        'This address points at a local machine, so it cannot be reached or tested. Submit a publicly reachable URL.',
      warnings,
    };
  }

  if (isIpLiteral(hostname)) {
    const classification = classifyAddress(hostname);
    if (!classification.safe) {
      return {
        ok: false,
        code: classification.code ?? 'private_address',
        message: `This address is not publicly reachable (${classification.reason}). Submit a public URL.`,
        warnings,
      };
    }
    warnings.push({
      code: 'ip_literal',
      message: 'URL uses a raw IP address rather than a domain name.',
    });
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return {
      ok: false,
      code: 'port_not_allowed',
      message: `Port ${url.port} is not supported. Use the standard https port.`,
      warnings,
    };
  }
  if (url.port && url.port !== '443' && url.port !== '80') {
    warnings.push({ code: 'nonstandard_port', message: `URL uses non-standard port ${url.port}.` });
  }

  const bareHost = hostname.replace(/^www\./, '');
  if (flagDocumentHosts && DOCUMENT_HOSTS.some((h) => hostname === h || bareHost === h || hostname.endsWith(`.${h}`))) {
    warnings.push({
      code: 'document_host',
      message:
        'This looks like a document or file-storage link rather than a running web application. Automated testing needs the live product URL.',
    });
  }
  if (flagVideoHosts && VIDEO_HOSTS.some((h) => hostname === h || bareHost === h)) {
    warnings.push({
      code: 'video_host',
      message: 'This looks like a video link. The product URL should point at the live application.',
    });
  }

  // Normalise: drop the fragment (never meaningful to a server), keep the query.
  url.hash = '';
  return { ok: true, normalised: url.toString(), warnings };
}

/** Product entry URL: HTTPS required, document and video hosts flagged. */
export function validateProductUrl(input: string): UrlValidationResult {
  return { ...validateUrl(input, { requireHttps: true, flagDocumentHosts: true, flagVideoHosts: true }) };
}

/** Demo video link: HTTPS required, document hosts flagged, video hosts expected. */
export function validateDemoVideoUrl(input: string): UrlValidationResult {
  return validateUrl(input, { requireHttps: true, flagDocumentHosts: false, flagVideoHosts: false });
}

// --------------------------------------------------------------------------
// Resolved-address checking (the layer that actually stops SSRF)
// --------------------------------------------------------------------------

export type DnsResolver = (hostname: string) => Promise<string[]>;

export interface ResolvedSafetyResult {
  safe: boolean;
  code?: UrlRejectionCode;
  reason?: string;
  addresses: string[];
}

/**
 * Resolve a hostname and reject if ANY resolved address is non-public.
 *
 * "Any", not "all": a hostname that returns both a public and a private address
 * is a rebinding attempt, not a misconfiguration.
 *
 * This must be called immediately before navigation, not only at plan time —
 * DNS can change between the two. See ADR-008 for the residual risk and the
 * network-layer egress policy that closes it.
 */
export async function assertResolvedAddressesSafe(
  hostname: string,
  resolve: DnsResolver,
): Promise<ResolvedSafetyResult> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (isIpLiteral(host)) {
    const classification = classifyAddress(host);
    return classification.safe
      ? { safe: true, addresses: [host] }
      : {
          safe: false,
          code: classification.code ?? 'private_address',
          reason: classification.reason,
          addresses: [host],
        };
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    return {
      safe: false,
      code: 'blocked_host',
      reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      addresses: [],
    };
  }

  if (addresses.length === 0) {
    return { safe: false, code: 'blocked_host', reason: 'Hostname resolved to no addresses.', addresses: [] };
  }

  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (!classification.safe) {
      return {
        safe: false,
        code: classification.code ?? 'private_address',
        reason: `Hostname resolves to a non-public address (${address}: ${classification.reason}).`,
        addresses,
      };
    }
  }

  return { safe: true, addresses };
}

/**
 * Full pre-navigation gate: syntax, then resolved addresses.
 * The worker calls this before every `navigate` action.
 */
export async function assertNavigationAllowed(
  rawUrl: string,
  resolve: DnsResolver,
): Promise<{ allowed: boolean; reason?: string; normalised?: string }> {
  const syntactic = validateUrl(rawUrl, { requireHttps: false });
  if (!syntactic.ok || !syntactic.normalised) {
    return { allowed: false, reason: syntactic.message ?? 'Invalid URL.' };
  }
  const { hostname } = new URL(syntactic.normalised);
  const resolved = await assertResolvedAddressesSafe(hostname, resolve);
  if (!resolved.safe) {
    return { allowed: false, reason: resolved.reason ?? 'Address is not publicly reachable.' };
  }
  return { allowed: true, normalised: syntactic.normalised };
}
