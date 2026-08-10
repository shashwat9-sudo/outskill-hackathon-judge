import { describe, expect, it } from 'vitest';
import {
  assertNavigationAllowed,
  assertResolvedAddressesSafe,
  classifyAddress,
  validateDemoVideoUrl,
  validateProductUrl,
  validateUrl,
} from './url.js';
import {
  csrfTokenMatches,
  decryptSecret,
  deserialiseEnvelope,
  encryptSecret,
  generateCsrfToken,
  generateInviteToken,
  hashInviteToken,
  inviteTokenMatches,
  maskSecret,
  parseEncryptionKey,
  serialiseEnvelope,
} from './crypto.js';
import {
  isLockedOut,
  registerFailedAttempt,
  registerSuccessfulLogin,
  MAX_FAILED_ATTEMPTS,
  validatePasswordStrength,
} from './password.js';

// --------------------------------------------------------------------------
// SSRF
// --------------------------------------------------------------------------

describe('SSRF address classification', () => {
  const blocked = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.254', 'private 172.16/12'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['198.18.0.1', 'benchmark range'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
  ] as const;

  it.each(blocked)('blocks %s (%s)', (address) => {
    expect(classifyAddress(address).safe).toBe(false);
  });

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];

  it.each(allowed)('allows public address %s', (address) => {
    expect(classifyAddress(address).safe).toBe(true);
  });

  it('does not treat 172.32.x as private (boundary above the /12)', () => {
    expect(classifyAddress('172.15.255.255').safe).toBe(true);
    expect(classifyAddress('172.16.0.0').safe).toBe(false);
    expect(classifyAddress('172.31.255.255').safe).toBe(false);
    expect(classifyAddress('172.32.0.0').safe).toBe(true);
  });
});

describe('URL validation', () => {
  it('accepts a normal public HTTPS product URL', () => {
    const result = validateProductUrl('https://my-product.example.com/app');
    expect(result.ok).toBe(true);
    expect(result.normalised).toBe('https://my-product.example.com/app');
  });

  it('rejects non-HTTP schemes', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'ftp://example.com', 'javascript:alert(1)']) {
      const result = validateUrl(url, { requireHttps: false });
      expect(result.ok, url).toBe(false);
    }
  });

  it('requires HTTPS for a product URL', () => {
    const result = validateProductUrl('http://my-product.example.com');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('scheme_not_https');
  });

  it('rejects localhost and private literals', () => {
    for (const url of [
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://192.168.0.10',
      'https://169.254.169.254',
      'https://app.localhost',
    ]) {
      expect(validateProductUrl(url).ok, url).toBe(false);
    }
  });

  it('rejects credentials embedded in the URL and explains where they belong', () => {
    const result = validateProductUrl('https://user:pass@example.com');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('credentials_in_url');
    expect(result.message).toMatch(/encrypted/i);
  });

  it('warns — but does not reject — a Drive-style document link', () => {
    const result = validateProductUrl('https://drive.google.com/drive/folders/abc123');
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('document_host');
  });

  it('warns when a product URL points at a video host', () => {
    const result = validateProductUrl('https://www.loom.com/share/abc');
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('video_host');
  });

  it('accepts a Loom link as a demo video without a video-host warning', () => {
    const result = validateDemoVideoUrl('https://www.loom.com/share/abc123');
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects malformed input and empty values', () => {
    expect(validateProductUrl('').ok).toBe(false);
    expect(validateProductUrl('not a url').ok).toBe(false);
    expect(validateProductUrl('example.com').ok).toBe(false);
  });

  it('strips the fragment when normalising', () => {
    const result = validateProductUrl('https://example.com/app?x=1#section');
    expect(result.normalised).toBe('https://example.com/app?x=1');
  });
});

describe('resolved-address checking', () => {
  it('rejects a hostname that resolves into private space', async () => {
    const result = await assertResolvedAddressesSafe('rebind.example.com', async () => ['10.0.0.5']);
    expect(result.safe).toBe(false);
    expect(result.code).toBe('private_address');
  });

  it('rejects when ANY resolved address is private, not only when all are', async () => {
    // A mixed answer is a rebinding attempt, not a misconfiguration.
    const result = await assertResolvedAddressesSafe('mixed.example.com', async () => [
      '93.184.216.34',
      '127.0.0.1',
    ]);
    expect(result.safe).toBe(false);
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    const result = await assertResolvedAddressesSafe('example.com', async () => ['93.184.216.34']);
    expect(result.safe).toBe(true);
  });

  it('rejects when DNS fails or returns nothing', async () => {
    const failed = await assertResolvedAddressesSafe('nope.example.com', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(failed.safe).toBe(false);

    const empty = await assertResolvedAddressesSafe('empty.example.com', async () => []);
    expect(empty.safe).toBe(false);
  });

  it('gates navigation on both syntax and resolved addresses', async () => {
    const publicResolver = async () => ['93.184.216.34'];
    const privateResolver = async () => ['192.168.1.1'];

    expect((await assertNavigationAllowed('https://example.com', publicResolver)).allowed).toBe(true);
    expect((await assertNavigationAllowed('https://example.com', privateResolver)).allowed).toBe(false);
    expect((await assertNavigationAllowed('file:///etc/passwd', publicResolver)).allowed).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Crypto
// --------------------------------------------------------------------------

describe('credential encryption (AES-256-GCM)', () => {
  const key = parseEncryptionKey(Buffer.alloc(32, 3).toString('base64'));

  it('round-trips a secret', () => {
    const envelope = encryptSecret('correct horse battery staple', key);
    expect(decryptSecret(envelope, key)).toBe('correct horse battery staple');
  });

  it('never stores the plaintext in the ciphertext', () => {
    const envelope = encryptSecret('SuperSecret123', key);
    expect(envelope.ciphertext.toString('utf8')).not.toContain('SuperSecret123');
    expect(envelope.ciphertext.toString('base64')).not.toContain('SuperSecret123');
  });

  it('produces a different ciphertext each time (unique IV)', () => {
    const a = encryptSecret('same input', key);
    const b = encryptSecret('same input', key);
    expect(a.ciphertext.toString('base64')).not.toBe(b.ciphertext.toString('base64'));
    expect(a.iv.toString('base64')).not.toBe(b.iv.toString('base64'));
  });

  it('fails to decrypt with the wrong key', () => {
    const envelope = encryptSecret('secret', key);
    const wrongKey = parseEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
    expect(() => decryptSecret(envelope, wrongKey)).toThrow();
  });

  it('detects tampering via the GCM auth tag', () => {
    const envelope = encryptSecret('secret value', key);
    envelope.ciphertext[0] = (envelope.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptSecret(envelope, key)).toThrow();
  });

  it('survives serialisation to string and back', () => {
    const envelope = encryptSecret('a stored credential', key);
    const restored = deserialiseEnvelope(serialiseEnvelope(envelope));
    expect(decryptSecret(restored, key)).toBe('a stored credential');
    expect(restored.keyVersion).toBe(envelope.keyVersion);
  });

  it('rejects a key of the wrong length rather than deriving one', () => {
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey('')).toThrow();
  });
});

describe('invite tokens', () => {
  it('generates high-entropy tokens and stores only a hash', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.tokenHash).toHaveLength(64);
    expect(a.tokenHash).not.toContain(a.token);
    expect(a.tokenPrefix).toBe(a.token.slice(0, 8));
  });

  it('matches only the correct token', () => {
    const { token, tokenHash } = generateInviteToken();
    expect(inviteTokenMatches(token, tokenHash)).toBe(true);
    expect(inviteTokenMatches(`${token}x`, tokenHash)).toBe(false);
    expect(inviteTokenMatches('', tokenHash)).toBe(false);
  });

  it('hashes deterministically so lookups work', () => {
    const { token, tokenHash } = generateInviteToken();
    expect(hashInviteToken(token)).toBe(tokenHash);
  });
});

describe('CSRF tokens', () => {
  it('compares constant-time and rejects mismatches', () => {
    const token = generateCsrfToken();
    expect(csrfTokenMatches(token, token)).toBe(true);
    expect(csrfTokenMatches(token, generateCsrfToken())).toBe(false);
    expect(csrfTokenMatches(token, '')).toBe(false);
    expect(csrfTokenMatches('', '')).toBe(false);
  });
});

describe('secret masking', () => {
  it('never reveals enough of a secret to be useful', () => {
    expect(maskSecret('SuperSecretPassword')).toBe('Su••••••••••');
    expect(maskSecret(null)).toBe('—');
    expect(maskSecret('ab')).toBe('••');
    expect(maskSecret('SuperSecretPassword')).not.toContain('Password');
  });
});

// --------------------------------------------------------------------------
// Passwords and lockout
// --------------------------------------------------------------------------

describe('password policy', () => {
  it('requires a reasonable length and rejects obvious values', () => {
    expect(validatePasswordStrength('short').ok).toBe(false);
    expect(validatePasswordStrength('password123').ok).toBe(false);
    expect(validatePasswordStrength('aaaaaaaaaaaaaaa').ok).toBe(false);
    expect(validatePasswordStrength('  padded password  ').ok).toBe(false);
    expect(validatePasswordStrength('a-perfectly-fine-shared-passphrase').ok).toBe(true);
  });
});

describe('lockout policy', () => {
  it('locks after the configured number of failures and clears on success', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      state = registerFailedAttempt(state);
      expect(isLockedOut(state)).toBe(false);
    }
    state = registerFailedAttempt(state);
    expect(isLockedOut(state)).toBe(true);

    state = registerSuccessfulLogin();
    expect(isLockedOut(state)).toBe(false);
    expect(state.failedAttempts).toBe(0);
  });

  it('expires the lockout once the window passes', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    const start = new Date('2026-03-13T00:00:00Z');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) state = registerFailedAttempt(state, start);

    expect(isLockedOut(state, new Date('2026-03-13T00:10:00Z'))).toBe(true);
    expect(isLockedOut(state, new Date('2026-03-13T00:20:00Z'))).toBe(false);
  });
});
