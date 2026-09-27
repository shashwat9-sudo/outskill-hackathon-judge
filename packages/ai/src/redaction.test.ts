import { describe, expect, it } from 'vitest';
import { assertNoCredentialShapedContent, redactDeep, redactText } from './redaction';

/**
 * The credential guard against its own redaction.
 *
 * The password redaction keeps its label and removes the value:
 * "password: [REMOVED]". The guard strips markers and re-tests, so anything
 * else on that line — "(case-sensitive)", "Username:", debris from an earlier
 * pattern — used to read as a password value and refuse a payload that held
 * no credential at all. AIAP C14 group 21 failed at artifact analysis that
 * way: the deck's last slide listed the demo login, the value was scrubbed,
 * and the guard refused the scrubbed text.
 *
 * What must stay true: a real, unredacted credential is still refused.
 */
describe('assertNoCredentialShapedContent', () => {
  it('accepts a scrubbed password whatever follows it on the line', () => {
    for (const line of [
      'Password: Hunter2!2026 (case-sensitive)',
      'Login — Username: judge@demo.invalid Password: Hunter2!2026 Steps below',
      'pwd = Hunter2!2026$ then click Sign in',
      'Demo account\nEmail: judge@demo.invalid\nPassword: Hunter2!2026$',
    ]) {
      const scrubbed = redactText(line).text;
      expect(scrubbed, line).not.toContain('Hunter2!2026');
      expect(() => assertNoCredentialShapedContent({ deckText: scrubbed }), line).not.toThrow();
    }
  });

  it('accepts marker debris left when two patterns overlapped', () => {
    // The exact residue from group 21: an earlier pattern replaced part of
    // the value, the password pattern then swallowed the opening bracket.
    expect(() => assertNoCredentialShapedContent('User ID: x password: [REMOVED] REMOVED]$')).not.toThrow();
    expect(() => assertNoCredentialShapedContent(['ok', { nested: 'password: [REMOVED] (case-sensitive)' }])).not.toThrow();
  });

  it('still refuses a labelled password that was not redacted', () => {
    expect(() => assertNoCredentialShapedContent({ text: 'password: hunter2!' })).toThrow(/labelled password/);
    expect(() => assertNoCredentialShapedContent('Passwd=Secr3tValue')).toThrow(/labelled password/);
    // A marker pair followed by a second, real value on the same line.
    expect(() => assertNoCredentialShapedContent('password: [REMOVED] password: stillhere1')).toThrow(/labelled password/);
  });

  it('still refuses the other credential shapes', () => {
    expect(() => assertNoCredentialShapedContent('https://user:pw@host.example.com/')).toThrow(/inline URL credentials/);
    expect(() => assertNoCredentialShapedContent('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toThrow(/bearer token/);
    expect(() => assertNoCredentialShapedContent('sk-abcdefghijklmnopqrstuvwx')).toThrow(/API key/);
  });

  it('accepts a whole redacted written submission and deck', () => {
    const written = redactDeep({
      writtenSubmission: 'Product: X\nKnown limitations: password: Hunter2!2026 must be typed exactly\nStack: Bolt',
      deckText: '[Page 8] Thank You\nUser ID: judge@demo.invalid password: Hunter2!2026$',
    });
    expect(JSON.stringify(written)).not.toContain('Hunter2!2026');
    expect(() => assertNoCredentialShapedContent(written)).not.toThrow();
  });
});
