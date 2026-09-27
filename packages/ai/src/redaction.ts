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

/**
 * Last-resort check on an assembled AI payload.
 *
 * Deliberately does NOT take the real credentials. The previous version did,
 * which meant a stored password had to be decrypted into memory in order to
 * prove it was not being sent — creating the exposure it was checking for.
 *
 * Instead this looks for the shapes a credential takes when a participant types
 * one into a field where it does not belong: a labelled password, a bearer
 * token, a URL with inline credentials. Those are participant mistakes rather
 * than payload-builder bugs, and they are the ones a structural allowlist
 * cannot catch.
 *
 * The guarantee that OUR stored credentials never enter a payload is
 * structural: no builder has a credential field. That is enforced by test, not
 * by inspecting the assembled string.
 */
export function assertNoCredentialShapedContent(payload: unknown): void {
  for (const value of collectStrings(payload)) {
    // Redaction markers are removed first. Without this the check fires on its
    // own success: `password: [REMOVED]` matches "a labelled password followed
    // by four non-space characters", so a submission that merely mentioned a
    // password — and was correctly scrubbed — would be refused. A guard that
    // rejects the output of the thing it guards is worse than no guard,
    // because the failure reads as a leak.
    //
    // The password redaction keeps its label — "password: [REMOVED]" — so
    // removing only the marker leaves "password: " in front of whatever else
    // was on that line. A slide reading "Password: hunter2 (case-sensitive)"
    // or "Username: u Password: p" therefore came back as "password:
    // (case-sensitive)" / "password:  Username:" and was refused although
    // the value was gone. AIAP C14 group 21 failed at artifact analysis for
    // exactly this. A scrubbed label-and-marker pair is dropped whole first;
    // a label still followed by a real value is, as before, refused.
    const text = value
      .replace(/\b(?:password|passwd|pwd|passcode|pin)[ \t]*[:=][ \t]*\[[A-Z ]*REMOVED\]/gi, '')
      .replace(/\[[A-Z ]*REMOVED\]/g, '');

    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.regex.test(text)) {
        throw new Error(
          `Refusing to send an AI payload that still contains ${shape.kind}. ` +
            'Redaction should have removed it before the payload was built.',
        );
      }
    }
  }
}

/**
 * Every string in a structure.
 *
 * The checks run per string rather than over `JSON.stringify(payload)`, because
 * serialising turns a newline into the two characters `\` and `n` — both
 * non-space. A "the value must be on the same line as the label" rule is
 * meaningless against that, and the first real provider run refused a clean
 * payload because of it.
 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

const CREDENTIAL_SHAPES: { kind: string; regex: RegExp }[] = [
  // `[ \t]*` rather than `\s*`: the value has to be on the same line as the
  // label, or the match runs past a newline into the next sentence.
  { kind: 'a labelled password', regex: /\b(?:password|passwd|pwd)[ \t]*[:=][ \t]*\S{4,}/i },
  { kind: 'inline URL credentials', regex: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/i },
  { kind: 'a bearer token', regex: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { kind: 'an API key', regex: /\b(?:sk|pk|api[_-]?key)[-_][A-Za-z0-9]{16,}/i },
];
