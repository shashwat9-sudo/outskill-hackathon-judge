import type { PartnerSubmissionInput } from '../data/postgres/repositories/partner';

/*
 * The CSV fallback reuses `parseCsv` from `utils/csv`. A second reader would
 * eventually disagree with the first about quoting, and the disagreement would
 * surface on the one day we needed the fallback.
 */

/**
 * Turning a spreadsheet row into something judgeable.
 *
 * The Outskill Hackathon product writes final submissions into a Google Sheet.
 * That sheet is the intake for production, and a CSV export of the same columns
 * is the fallback for the day Google is unavailable. Both arrive here, because
 * two parsers would eventually disagree about something that matters — and the
 * one that mattered would be whichever we used least and tested least.
 *
 * Three things this file is careful about.
 *
 * HEADERS, NEVER POSITIONS. Someone will reorder the columns, or insert one, on
 * the morning of the hackathon. Every lookup goes through a normalised header
 * name, so a reordered sheet is a non-event and a missing required column is an
 * explicit error rather than a row of shifted values quietly judged as if they
 * were right.
 *
 * PII STAYS OUT. The sheet carries Team Leader, Team Members and Primary
 * Contact, because the Hackathon product needs them. Judging does not: a
 * submission is "Group 12" here and nowhere else. Those columns are read past,
 * never mapped, and never reach a provider.
 *
 * PASSWORDS ARE NOT DATA. A login password is carried to exactly one place —
 * encrypted credential storage — and is absent from the normalised payload's
 * snapshot, from validation messages, from the sync report and from logs.
 */

/** The columns the Hackathon product writes, in the order it writes them. */
export const SHEET_HEADERS = [
  'Timestamp',
  'Group Number',
  'Category',
  'Product Name',
  'Team Leader',
  'Team Members',
  'Primary Contact',
  'MVP/Product Link',
  'Access',
  'Login Email',
  'Login Password',
  'Brief Description',
  'Main User Action',
  'How AI Helps',
  'What We Got Working',
  'Loom Video Link',
  'Final Deck Link',
] as const;

/**
 * The columns judging cannot proceed without.
 *
 * Deliberately shorter than the list above: Loom and deck are supporting
 * evidence and their absence is a scoring outcome, not an intake failure.
 */
export const REQUIRED_HEADERS = [
  'Group Number',
  'Category',
  'Product Name',
  'MVP/Product Link',
  'Access',
  'Brief Description',
  'Main User Action',
  'How AI Helps',
  'What We Got Working',
] as const;

/**
 * Columns that exist in the sheet and must never enter judging.
 *
 * Named rather than merely omitted, so that a future change adding "everything
 * else" to the payload has to delete this list first.
 */
export const EXCLUDED_PII_HEADERS = ['Team Leader', 'Team Members', 'Primary Contact'] as const;

/**
 * Alternative spellings we will accept for a canonical column.
 *
 * Deliberately short. The production headers above are canonical, and every
 * alias here is a rewording of the same question rather than a guess at what a
 * column might mean — mapping an ambiguous column is how a product URL ends up
 * being judged as a Loom link. Anything not listed fails closed.
 */
const HEADER_ALIASES: Record<string, readonly string[]> = {
  'Group Number': ['Group', 'Group No', 'Group #', 'Team Number', 'Group Number '],
  'MVP/Product Link': ['MVP Link', 'Product Link', 'MVP / Product Link', 'Product URL', 'MVP URL'],
  Access: ['Access Type', 'Access Mode'],
  'Login Email': ['Judge Login Email', 'Test Login Email', 'Username'],
  'Login Password': ['Judge Login Password', 'Test Login Password'],
  'Brief Description': ['Description', 'Short Description'],
  'Main User Action': ['Main User Action ', 'Primary User Action', 'Main Thing A User Can Do'],
  'How AI Helps': ['AI Value', 'How AI Is Used', 'How Does AI Help'],
  'What We Got Working': ['What Got Working', 'What We Built', 'What Works'],
  'Loom Video Link': ['Loom Link', 'Loom', 'Demo Video Link', 'Demo Link'],
  'Final Deck Link': ['Deck Link', 'Deck', 'Final Deck', 'Presentation Link'],
  Category: ['Idea', 'Selected Idea', 'Product Category'],
  'Product Name': ['Name Of Product', 'App Name'],
  Timestamp: ['Submitted At', 'Submission Time'],
};

/** Every accepted spelling of one canonical header, normalised. */
export function headerCandidates(canonical: string): string[] {
  return [canonical, ...(HEADER_ALIASES[canonical] ?? [])].map(normaliseHeader);
}

/** Lowercase, collapse whitespace, drop punctuation a human might vary. */
export function normaliseHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');
}

export interface SheetRowIssue {
  /** 1-based row number as a human sees it in the sheet. */
  row: number;
  groupNumber: number | null;
  field: string;
  reason: string;
}

export interface ResubmittedGroup {
  groupNumber: number;
  /** The sheet row that will be judged. */
  selectedRow: number;
  /** Valid rows this one replaced. Kept for the report, never judged. */
  supersededRows: number[];
  /**
   * Set when a newer row existed and could not be used.
   *
   * A later broken submission must not silently discard an earlier working one,
   * so the older valid row is still judged and this says why the newer one was
   * not — otherwise a team would be marked on a submission they had replaced,
   * with nothing on screen explaining it.
   */
  newestRejected?: { row: number; reason: string };
}

export interface NormalisedRow {
  row: number;
  groupNumber: number;
  /** Parsed Google Form timestamp, or null when absent/unreadable. */
  submittedAt: Date | null;
  /** Everything judging needs. No PII, no password. */
  input: Omit<PartnerSubmissionInput, 'externalCohortId' | 'externalSubmissionId'> & {
    whatGotWorking: string;
  };
  /** Carried separately so it never lands in a snapshot or a report. */
  credentials: { username: string; password: string } | null;
}

export interface ParsedIntakeSheet {
  headers: string[];
  rowsRead: number;
  blankRowsIgnored: number;
  valid: NormalisedRow[];
  invalid: SheetRowIssue[];
  /** Groups appearing more than once. Never judged automatically. */
  /**
   * Groups that submitted the form more than once.
   *
   * Resubmitting is ordinary behaviour — a team fixes a broken link and sends
   * the form again — so one row is chosen rather than the group being blocked.
   */
  resubmittedGroups: ResubmittedGroup[];
  /** Fatal: the sheet cannot be used at all. */
  fatalError?: string;
}

/*
 * What the submission product actually writes, alongside our canonical labels.
 *
 * The Judge was only accepting its own vocabulary. The upstream form presents
 * "Open (any account works)" and "Requires shared credentials" to learners, and
 * every real submission arrived carrying those — so the first two production
 * rows were both rejected for an Access value that was entirely correct.
 *
 * Enumerated rather than matched loosely. Access decides whether a browser is
 * sent at a login wall with no credentials, and a fuzzy rule that reads
 * "requires shared credentials" correctly today will read something else
 * correctly-looking tomorrow. New wording gets added here deliberately.
 */
const OPEN_ACCESS = new Set([
  'open',
  'open access',
  'openaccess',
  'public',
  'no login',
  'none',
  // As written by the submission product.
  'open any account works',
  'open any account',
  'anyone can access',
]);
const SPECIFIC_LOGIN = new Set([
  'specific login',
  'login',
  'specific',
  'credentials',
  'requires login',
  'login required',
  // As written by the submission product.
  'requires shared credentials',
  'shared credentials',
  'requires credentials',
]);

/**
 * Which access mode a cell means, or nothing.
 *
 * Case and spacing are normalised because a human typed it. Anything genuinely
 * unrecognised returns null and the row is refused — guessing would either send
 * a browser at a login wall with no credentials, or skip a login the team
 * intended, and both end with a team's working product scored as broken.
 */
export function normaliseAccessMode(value: string): 'open' | 'credentials' | null {
  const cleaned = value.toLowerCase().replace(/[^a-z ]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  if (OPEN_ACCESS.has(cleaned)) return 'open';
  if (SPECIFIC_LOGIN.has(cleaned)) return 'credentials';
  return null;
}

/**
 * The Google Form timestamp, in the shapes a sheet actually holds it.
 *
 * Forms write a locale-formatted string rather than ISO, and a sheet that has
 * been exported and re-imported can hold almost anything. A value we cannot
 * read returns null rather than a guess: an invented date would silently decide
 * which of a team's submissions gets judged.
 */
export function parseSheetTimestamp(value: string): Date | null {
  const raw = value.trim();
  if (!raw) return null;

  // `2026-09-11 17:42:03` — Forms' default. Treated as ISO by making the
  // separator explicit; anything else falls through to Date's own parsing.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(:(\d{2}))?$/.exec(raw);
  const parsed = iso ? new Date(raw.replace(' ', 'T')) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A group number as the sheet might contain it: "12", " 12 ", "Group 12". */
export function normaliseGroupNumber(value: string): number | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

/**
 * Syntactic only, on purpose.
 *
 * Parsing a sheet must not make outbound requests: a spreadsheet full of
 * learner-supplied URLs is exactly the input an SSRF wants, and reachability is
 * the hardened worker's job behind its egress proxy. All this decides is
 * whether a string is shaped like a URL we would be willing to hand over.
 */
export function isSyntacticallyValidUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ParseOptions {
  /** Slugs of the approved ideas. A Category must match one of them. */
  approvedCategories: { slug: string; title: string }[];
}

/**
 * One row, validated and normalised, or the reasons it cannot be judged.
 *
 * Every issue names a row, a field and a safe reason. None of them contains a
 * password, an email or a learner's name — an operator reading a sync report
 * should be able to paste it into a chat without leaking anything.
 */
function normaliseRow(
  rowNumber: number,
  cells: Record<string, string>,
  options: ParseOptions,
): { ok: true; value: NormalisedRow } | { ok: false; issues: SheetRowIssue[] } {
  const issues: SheetRowIssue[] = [];
  const get = (header: string) => {
    for (const candidate of headerCandidates(header)) {
      const value = cells[candidate];
      if (value !== undefined) return value.trim();
    }
    return '';
  };

  const groupNumber = normaliseGroupNumber(get('Group Number'));
  const fail = (field: string, reason: string) =>
    issues.push({ row: rowNumber, groupNumber, field, reason });

  if (groupNumber === null) fail('Group Number', 'Missing or not a number between 1 and 999.');

  const categoryRaw = get('Category');
  const category = options.approvedCategories.find(
    (c) =>
      normaliseHeader(c.title) === normaliseHeader(categoryRaw) ||
      c.slug === normaliseHeader(categoryRaw).replace(/_/g, '-'),
  );
  if (!categoryRaw) fail('Category', 'Missing.');
  else if (!category) fail('Category', 'Does not match one of the approved ideas.');

  const productName = get('Product Name');
  if (!productName) fail('Product Name', 'Missing.');

  const productUrl = get('MVP/Product Link');
  if (!productUrl) fail('MVP/Product Link', 'Missing.');
  else if (!isSyntacticallyValidUrl(productUrl))
    fail('MVP/Product Link', 'Not a valid http(s) URL.');

  const accessMode = normaliseAccessMode(get('Access'));
  if (!get('Access')) fail('Access', 'Missing.');
  else if (!accessMode)
    fail('Access', 'Unrecognised value. Expected "Open Access" or "Specific Login".');

  for (const [header, label] of [
    ['Brief Description', 'Brief Description'],
    ['Main User Action', 'Main User Action'],
    ['How AI Helps', 'How AI Helps'],
    ['What We Got Working', 'What We Got Working'],
  ] as const) {
    if (!get(header)) fail(label, 'Missing.');
  }

  /*
   * Credentials, handled by access mode rather than by presence.
   *
   * An open-access row with something typed in the login cells is not an error
   * — a team filled in a box they did not need to. Those values are dropped
   * rather than carried, because storing a credential nobody asked for is worse
   * than ignoring one.
   */
  let credentials: { username: string; password: string } | null = null;
  if (accessMode === 'credentials') {
    const username = get('Login Email');
    const password = get('Login Password');
    if (!username) fail('Login Email', 'Required when Access is "Specific Login".');
    if (!password) fail('Login Password', 'Required when Access is "Specific Login".');
    if (username && password) credentials = { username, password };
  }

  const loomUrl = get('Loom Video Link');
  if (loomUrl && !isSyntacticallyValidUrl(loomUrl))
    fail('Loom Video Link', 'Not a valid http(s) URL.');

  const deckUrl = get('Final Deck Link');
  if (deckUrl && !isSyntacticallyValidUrl(deckUrl))
    fail('Final Deck Link', 'Not a valid http(s) URL.');

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      row: rowNumber,
      groupNumber: groupNumber!,
      submittedAt: parseSheetTimestamp(get('Timestamp')),
      input: {
        groupNumber: groupNumber!,
        ideaSlug: category!.slug,
        productName,
        briefDescription: get('Brief Description'),
        mainUserAction: get('Main User Action'),
        aiValue: get('How AI Helps'),
        whatGotWorking: get('What We Got Working'),
        productUrl,
        accessMode: accessMode!,
        // Never in the payload; carried alongside and sealed by the caller.
        judgeCredentials: null,
        loomUrl: loomUrl || null,
        deckUrl: deckUrl || null,
        submittedAt: get('Timestamp') || null,
      },
      credentials,
    },
  };
}

/**
 * Parse a whole sheet: a header row followed by data rows.
 *
 * `rows[0]` is the header. Row numbers in the result are 1-based and match what
 * an operator sees in the spreadsheet, because a report saying "row 14" has to
 * mean the row they can click on.
 */
export function parseSheetRows(rows: string[][], options: ParseOptions): ParsedIntakeSheet {
  const headerRow = rows[0];
  if (!headerRow || headerRow.length === 0) {
    return {
      headers: [],
      rowsRead: 0,
      blankRowsIgnored: 0,
      valid: [],
      invalid: [],
      resubmittedGroups: [],
      fatalError: 'The sheet is empty — no header row was found.',
    };
  }

  const headers = headerRow.map((h) => h.trim());
  const normalised = headers.map(normaliseHeader);

  const missing = REQUIRED_HEADERS.filter(
    (h) => !headerCandidates(h).some((candidate) => normalised.includes(candidate)),
  );
  if (missing.length > 0) {
    /*
     * Refused whole, not row by row.
     *
     * A missing column is a configuration problem affecting every row, and
     * ingesting the rest would quietly judge a cohort on partial information.
     */
    return {
      headers,
      rowsRead: 0,
      blankRowsIgnored: 0,
      valid: [],
      invalid: [],
      resubmittedGroups: [],
      fatalError: `The sheet is missing required column(s): ${missing.join(', ')}.`,
    };
  }

  const valid: NormalisedRow[] = [];
  const invalid: SheetRowIssue[] = [];
  let rowsRead = 0;
  let blankRowsIgnored = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i] ?? [];
    const rowNumber = i + 1;

    // A row where every cell is empty is spreadsheet padding, not a submission.
    if (cells.every((cell) => (cell ?? '').trim() === '')) {
      blankRowsIgnored += 1;
      continue;
    }
    rowsRead += 1;

    const byHeader: Record<string, string> = {};
    normalised.forEach((key, index) => {
      byHeader[key] = (cells[index] ?? '').toString();
    });

    const result = normaliseRow(rowNumber, byHeader, options);
    if (result.ok) valid.push(result.value);
    else invalid.push(...result.issues);
  }

  /*
   * A group that submitted twice, resolved rather than blocked.
   *
   * Resubmitting is ordinary: a team notices a broken link ten minutes before
   * the deadline and sends the form again. Refusing to judge either row would
   * punish exactly the teams who were paying attention, so the most recent
   * submission wins and the earlier ones are recorded as superseded.
   *
   * "Most recent VALID" is the part that matters. A newer row that fails
   * validation — an empty product URL, a login mode with no password — does not
   * replace an older working one. The older row is judged and the report says
   * why the newer was not used, because a team seeing a low mark deserves to
   * know which of their submissions produced it.
   *
   * Ordering falls back to sheet position when timestamps are missing or
   * unreadable: Google Forms appends, so a later row is a later submission. A
   * fabricated date would decide this silently, and this decision should never
   * be silent.
   */
  const laterThan = (a: NormalisedRow, b: NormalisedRow): boolean => {
    if (a.submittedAt && b.submittedAt) return a.submittedAt.getTime() > b.submittedAt.getTime();
    // A row with a readable timestamp is preferred over one without.
    if (a.submittedAt && !b.submittedAt) return true;
    if (!a.submittedAt && b.submittedAt) return false;
    return a.row > b.row;
  };

  const validByGroup = new Map<number, NormalisedRow[]>();
  for (const row of valid) {
    validByGroup.set(row.groupNumber, [...(validByGroup.get(row.groupNumber) ?? []), row]);
  }

  /** Invalid rows that still declared a group, so a rejection can be explained. */
  const invalidByGroup = new Map<number, SheetRowIssue[]>();
  for (const issue of invalid) {
    if (issue.groupNumber === null) continue;
    invalidByGroup.set(issue.groupNumber, [...(invalidByGroup.get(issue.groupNumber) ?? []), issue]);
  }

  const selected: NormalisedRow[] = [];
  const resubmittedGroups: ResubmittedGroup[] = [];

  for (const [groupNumber, rows] of validByGroup) {
    const ordered = [...rows].sort((a, b) => (laterThan(a, b) ? -1 : 1));
    const winner = ordered[0]!;
    selected.push(winner);

    const supersededRows = ordered.slice(1).map((r) => r.row);

    /*
     * Was there a newer row that could not be used?
     *
     * Only rows after the winner count: an invalid row older than the one being
     * judged is simply an earlier attempt and needs no explanation.
     */
    const newerInvalid = (invalidByGroup.get(groupNumber) ?? []).filter((issue) => issue.row > winner.row);
    const newestRejected = newerInvalid.length > 0
      ? {
          row: Math.max(...newerInvalid.map((i) => i.row)),
          reason: newerInvalid
            .filter((i) => i.row === Math.max(...newerInvalid.map((x) => x.row)))
            .map((i) => `${i.field} — ${i.reason}`)
            .join(' '),
        }
      : undefined;

    if (supersededRows.length > 0 || newestRejected) {
      resubmittedGroups.push({
        groupNumber,
        selectedRow: winner.row,
        supersededRows,
        ...(newestRejected ? { newestRejected } : {}),
      });
    }
  }

  return {
    headers,
    rowsRead,
    blankRowsIgnored,
    valid: selected,
    invalid,
    resubmittedGroups,
  };
}

/**
 * The submission identity for a sheet row.
 *
 * Deterministic, and derived from the group rather than from where the row
 * happens to sit. A sheet gets sorted, filtered and has rows inserted above
 * others; identity based on row number or timestamp would make every one of
 * those look like a new submission and judge the same product again.
 */
export const SHEET_SOURCE = 'outskill-google-sheets' as const;

export function sheetSubmissionId(groupNumber: number): string {
  return `group-${groupNumber}`;
}
