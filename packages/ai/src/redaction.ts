/**
 * PII redaction, applied before anything crosses the provider boundary.
 *
 * Privacy rules 8 and 10 are absolute: names, emails, phone numbers, passwords
 * and credentials never reach an AI provider, and submissions are identified by
 * an anonymised id only.
 *
 * Two layers, because either alone is insufficient:
 *
 *   1. STRUCTURAL — payloads are built from an explicit allowlist of fields.
 *      Credential fields are simply not part of any builder, so there is no
 *      path for them to be included (ADR-009).
 *   2. PATTERN — a scrubbing pass over the assembled text, catching PII that a
 *      participant typed into a free-text field where it did not belong. The
 *      historical exports show this happens constantly.
 *
 * Layer 1 stops what we control. Layer 2 stops what participants do.
 */

export interface RedactionResult {
  text: string;
  /** What was removed, by category — surfaced to admins, never the values. */
  redactions: { kind: RedactionKind; count: number }[];
}

export type RedactionKind =
  | 'email'
  | 'phone'
  | 'url_credentials'
  | 'api_key'
  | 'long_token'
  | 'named_person'
  | 'password_label';

interface Pattern {
  kind: RedactionKind;
  regex: RegExp;
  replacement: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'email',
    regex: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g,
    replacement: '[EMAIL REMOVED]',
  },
  {
    kind: 'url_credentials',
    // https://user:pass@host — strip before the URL is ever shown to a model.
    regex: /(https?:\/\/)[^/\s:@]+:[^/\s:@]+@/gi,
    replacement: '$1[CREDENTIALS REMOVED]@',
  },
  {
    kind: 'phone',
    // Seven or more digits with common separators, and an optional country code.
    regex: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g,
    replacement: '[PHONE REMOVED]',
  },
  {
    kind: 'api_key',
    regex: /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{16,}\b/gi,
    replacement: '[KEY REMOVED]',
  },
  {
    kind: 'long_token',
    // Long unbroken alphanumeric runs are almost always secrets, not prose.
    regex: /\b[A-Za-z0-9_-]{40,}\b/g,
    replacement: '[TOKEN REMOVED]',
  },
  {
    kind: 'password_label',
    // "password: hunter2", "pwd = ...", "login is admin/admin"
    regex: /\b(?:password|passwd|pwd|passcode|pin)\s*[:=]\s*\S+/gi,
    replacement: 'password: [REMOVED]',
  },
];

/**
 * Phone matching is aggressive and would otherwise eat dates, version numbers
 * and measurements. These are checked first and left alone.
 */
const PHONE_FALSE_POSITIVES = [
  /^\d{4}-\d{2}-\d{2}$/, // ISO date
  /^\d{1,2}[:.]\d{2}$/, // time
  /^v?\d+\.\d+(\.\d+)?$/, // version
];

export function redactText(input: string): RedactionResult {
  if (!input) return { text: '', redactions: [] };

  let text = input;
  const counts = new Map<RedactionKind, number>();

  for (const pattern of PATTERNS) {
    text = text.replace(pattern.regex, (match, ...args) => {
      if (pattern.kind === 'phone') {
        const digits = match.replace(/\D/g, '');
        // Too few digits to be a phone number, or a date/time/version.
        if (digits.length < 7) return match;
        if (PHONE_FALSE_POSITIVES.some((fp) => fp.test(match.trim()))) return match;
      }
      counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + 1);
      // Support the one pattern with a capture group.
      return pattern.replacement.replace('$1', typeof args[0] === 'string' ? args[0] : '');
    });
  }

  return {
    text,
    redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

/**
 * Remove known personal names.
 *
 * Called with the names the system already holds for a submission (team lead,
 * members). A name typed into a description is not detectable by pattern —
 * only by knowing it — so this closes the gap that `redactText` cannot.
 */
export function redactKnownNames(input: string, names: readonly string[]): RedactionResult {
  let text = input;
  let count = 0;

  // Longest first, so "Priya Sharma" is replaced before "Priya".
  const sorted = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]))]
    .map((n) => n.trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    text = text.replace(regex, () => {
      count += 1;
      return '[NAME REMOVED]';
    });
  }

  return { text, redactions: count > 0 ? [{ kind: 'named_person', count }] : [] };
}

/** Recursively redact every string in a structure. */
export function redactDeep<T>(value: T, names: readonly string[] = []): T {
  const scrub = (text: string): string => {
    const named = redactKnownNames(text, names);
    return redactText(named.text).text;
  };

  const walk = (input: unknown, depth = 0): unknown => {
    if (depth > 10) return '[MAX DEPTH]';
    if (typeof input === 'string') return scrub(input);
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item, depth + 1)]),
      );
    }
    return input;
  };

  return walk(value) as T;
}

/**
 * Final gate before a payload leaves the process.
 *
 * Throws rather than redacting when something that should be structurally
 * impossible appears — a credential in an AI payload means a builder is wrong,
 * and quietly scrubbing it would hide the bug.
 */
export function assertNoCredentials(payload: unknown, forbidden: readonly string[]): void {
  const serialised = JSON.stringify(payload) ?? '';
  for (const value of forbidden) {
    if (value && value.length >= 4 && serialised.includes(value)) {
      throw new Error(
        'Refusing to send an AI payload containing a stored credential. This is a bug in the payload builder, not a redaction failure.',
      );
    }
  }
}
