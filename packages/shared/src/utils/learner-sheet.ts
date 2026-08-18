/**
 * The Outskill learner allocation sheet.
 *
 * The programme team already maintains a sheet with one row per LEARNER:
 *
 *     Name | Email | Group | Link
 *
 * Many learners share a group; the group is the hackathon team. Asking the
 * programme team to collapse 1,000 learner rows into 100 team rows by hand
 * before every cohort would be error-prone work a computer should do — and the
 * errors would be silent, because a mistyped group number still imports.
 *
 * So this parses their real format and does the grouping itself. It never
 * mutates anything: it produces a PREVIEW, and the import is a separate step the
 * operator confirms after reading it.
 */

export interface LearnerRow {
  /** 1-based, counting the header, so it matches what the spreadsheet shows. */
  rowNumber: number;
  name: string;
  email: string;
  groupNumber: number;
  whatsappLink: string | null;
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
  /** The raw cells, so the operator can find the row in their sheet. */
  raw: Record<string, string>;
}

export type WarningSeverity = 'warning' | 'notice';

export interface ImportWarning {
  severity: WarningSeverity;
  code: string;
  message: string;
  /** Group numbers or row numbers the warning concerns. */
  affects: (string | number)[];
}

export interface GroupPreview {
  groupNumber: number;
  learners: LearnerRow[];
  whatsappLink: string | null;
  /** True when this group already exists in the cohort. */
  existing: boolean;
}

export interface ImportPreview {
  learnerRowsRead: number;
  uniqueGroups: number;
  newTeams: number;
  existingTeamsMatched: number;
  groups: GroupPreview[];
  rejected: RejectedRow[];
  warnings: ImportWarning[];
  /** Safe to proceed at all. False when nothing usable was found. */
  importable: boolean;
  /**
   * Problems that must be fixed in the sheet before importing.
   *
   * Distinct from warnings: a warning is worth reading, a blocker means the
   * import would produce data nobody intended.
   */
  blockers: string[];
}

// --------------------------------------------------------------------------
// Column matching
// --------------------------------------------------------------------------

/**
 * Accepted spellings for each column.
 *
 * Deliberately a closed list. Fuzzy matching would eventually decide that
 * "Email Address of Mentor" is the learner email, and the failure would be
 * silent — every learner imported under the wrong identity.
 */
const COLUMN_ALIASES: Record<keyof Omit<LearnerRow, 'rowNumber'>, string[]> = {
  name: ['name', 'learner name', 'student name', 'full name', 'learner'],
  email: ['email', 'email address', 'learner email', 'student email', 'e-mail'],
  groupNumber: ['group', 'group number', 'group no', 'group #', 'team', 'team number'],
  whatsappLink: ['link', 'whatsapp link', 'whatsapp group link', 'whatsapp', 'group link'],
};

function normaliseHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[._]/g, ' ');
}

export interface ColumnMapping {
  name: number;
  email: number;
  groupNumber: number;
  whatsappLink: number | null;
  /** Headings present in the file that were not recognised. Reported, not used. */
  unmatched: string[];
}

export function mapColumns(headings: string[]): ColumnMapping | { error: string } {
  const normalised = headings.map(normaliseHeading);
  const find = (key: keyof typeof COLUMN_ALIASES): number =>
    normalised.findIndex((heading) => COLUMN_ALIASES[key].includes(heading));

  const name = find('name');
  const email = find('email');
  const groupNumber = find('groupNumber');
  const whatsappLink = find('whatsappLink');

  const missing = [
    name === -1 ? 'Name' : null,
    email === -1 ? 'Email' : null,
    groupNumber === -1 ? 'Group' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    return {
      error:
        `Could not find ${missing.join(', ')} in the sheet. ` +
        `Found: ${headings.map((h) => `"${h.trim()}"`).join(', ')}. ` +
        'The importer expects columns named Name, Email, Group and optionally Link.',
    };
  }

  const used = new Set([name, email, groupNumber, whatsappLink]);
  return {
    name,
    email,
    groupNumber,
    whatsappLink: whatsappLink === -1 ? null : whatsappLink,
    unmatched: headings.filter((_, i) => !used.has(i)).map((h) => h.trim()).filter(Boolean),
  };
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

/** Split a CSV line, honouring quoted cells containing commas. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '"') {
      // A doubled quote inside a quoted cell is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Accept a pasted spreadsheet selection as well as a CSV file.
 *
 * Pasting from Sheets or Excel yields tab-separated values, and an operator who
 * has just selected 1,000 rows should not have to export a file first.
 */
function detectDelimiter(headerLine: string): 'tab' | 'comma' {
  return headerLine.includes('\t') && headerLine.split('\t').length > headerLine.split(',').length
    ? 'tab'
    : 'comma';
}

export interface ParsedSheet {
  rows: LearnerRow[];
  rejected: RejectedRow[];
  mapping: ColumnMapping | null;
  error: string | null;
}

export function parseLearnerSheet(text: string): ParsedSheet {
  const lines = text
    .split(/\r?\n/)
    .filter((line, index) => index === 0 || line.trim().length > 0);

  if (lines.length === 0 || !lines[0]?.trim()) {
    return { rows: [], rejected: [], mapping: null, error: 'The file is empty.' };
  }

  const delimiter = detectDelimiter(lines[0] as string);
  const split = (line: string) =>
    delimiter === 'tab' ? line.split('\t').map((c) => c.trim()) : splitCsvLine(line);

  const mapping = mapColumns(split(lines[0] as string));
  if ('error' in mapping) {
    return { rows: [], rejected: [], mapping: null, error: mapping.error };
  }

  const rows: LearnerRow[] = [];
  const rejected: RejectedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNumber = i + 1; // 1-based, header included, matching the spreadsheet
    const cells = split(lines[i] as string);
    const cell = (index: number | null): string =>
      index === null ? '' : (cells[index] ?? '').trim();

    const raw = {
      Name: cell(mapping.name),
      Email: cell(mapping.email),
      Group: cell(mapping.groupNumber),
      Link: cell(mapping.whatsappLink),
    };

    // A wholly blank line in the middle of a sheet is normal formatting, not an
    // error worth reporting.
    if (Object.values(raw).every((value) => value === '')) continue;

    const problems: string[] = [];
    if (!raw.Name) problems.push('missing Name');
    if (!raw.Email) problems.push('missing Email');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.Email)) {
      problems.push(`"${raw.Email}" is not a valid email address`);
    }

    const groupNumber = Number.parseInt(raw.Group.replace(/[^0-9-]/g, ''), 10);
    if (!raw.Group) problems.push('missing Group');
    else if (!Number.isInteger(groupNumber)) problems.push(`Group "${raw.Group}" is not a number`);
    else if (groupNumber < 1 || groupNumber > 999) {
      problems.push(`Group ${groupNumber} is outside the allowed range 1–999`);
    }

    if (problems.length > 0) {
      rejected.push({ rowNumber, reason: problems.join('; '), raw });
      continue;
    }

    rows.push({
      rowNumber,
      name: raw.Name,
      email: raw.Email.toLowerCase(),
      groupNumber,
      whatsappLink: raw.Link || null,
    });
  }

  return { rows, rejected, mapping, error: null };
}

// --------------------------------------------------------------------------
// Preview
// --------------------------------------------------------------------------

/** Groups smaller or larger than this are worth a second look, not a refusal. */
const SMALL_GROUP = 2;
const LARGE_GROUP = 12;

export function buildImportPreview(
  parsed: ParsedSheet,
  existingGroupNumbers: readonly number[],
): ImportPreview {
  const warnings: ImportWarning[] = [];
  const existing = new Set(existingGroupNumbers);

  const byGroup = new Map<number, LearnerRow[]>();
  for (const row of parsed.rows) {
    const list = byGroup.get(row.groupNumber) ?? [];
    list.push(row);
    byGroup.set(row.groupNumber, list);
  }

  // --- an email appearing in more than one group ---
  const groupsByEmail = new Map<string, Set<number>>();
  for (const row of parsed.rows) {
    const groups = groupsByEmail.get(row.email) ?? new Set<number>();
    groups.add(row.groupNumber);
    groupsByEmail.set(row.email, groups);
  }
  // A learner in two groups of one cohort is not a warning, it is a defect in
  // the sheet: whichever team is created second would silently be missing them,
  // or they would hold two access codes. The database index is scoped to a team
  // and cannot catch this, so it is caught here — and it BLOCKS.
  const blockers: string[] = [];
  for (const [email, groups] of groupsByEmail) {
    if (groups.size > 1) {
      const list = [...groups].sort((a, b) => a - b).join(', ');
      blockers.push(
        `${email} is assigned to groups ${list}. A learner can only be on one team — ` +
          'fix the sheet and import again.',
      );
      warnings.push({
        severity: 'warning',
        code: 'learner_in_multiple_groups',
        message: `${email} appears in groups ${list}.`,
        affects: [...groups],
      });
    }
  }

  const groups: GroupPreview[] = [...byGroup.entries()]
    .sort(([a], [b]) => a - b)
    .map(([groupNumber, learners]) => {
      // --- the same email twice in one group ---
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const learner of learners) {
        if (seen.has(learner.email)) duplicates.add(learner.email);
        seen.add(learner.email);
      }
      if (duplicates.size > 0) {
        warnings.push({
          severity: 'notice',
          code: 'duplicate_learner_in_group',
          message:
            `Group ${groupNumber} lists ${[...duplicates].join(', ')} more than once. ` +
            'Only one member record will be created for each.',
          affects: [groupNumber],
        });
      }

      // --- conflicting WhatsApp links inside one group ---
      const links = [...new Set(learners.map((l) => l.whatsappLink).filter(Boolean))] as string[];
      if (links.length > 1) {
        warnings.push({
          severity: 'warning',
          code: 'conflicting_whatsapp_links',
          message:
            `Group ${groupNumber} has ${links.length} different WhatsApp links. ` +
            'The first will be used — check which is correct.',
          affects: [groupNumber],
        });
      }

      const uniqueLearners = learners.filter(
        (learner, index) => learners.findIndex((l) => l.email === learner.email) === index,
      );

      if (uniqueLearners.length < SMALL_GROUP) {
        warnings.push({
          severity: 'notice',
          code: 'small_group',
          message: `Group ${groupNumber} has only ${uniqueLearners.length} learner(s).`,
          affects: [groupNumber],
        });
      }
      if (uniqueLearners.length > LARGE_GROUP) {
        warnings.push({
          severity: 'notice',
          code: 'large_group',
          message: `Group ${groupNumber} has ${uniqueLearners.length} learners, which is unusually large.`,
          affects: [groupNumber],
        });
      }

      return {
        groupNumber,
        learners: uniqueLearners,
        whatsappLink: links[0] ?? null,
        existing: existing.has(groupNumber),
      };
    });

  if (parsed.rejected.length > 0) {
    warnings.push({
      severity: 'warning',
      code: 'rejected_rows',
      message:
        `${parsed.rejected.length} row(s) could not be read and will NOT be imported. ` +
        'Download the error report, fix them in the sheet, and import again.',
      affects: parsed.rejected.map((r) => r.rowNumber),
    });
  }

  if (parsed.mapping && parsed.mapping.unmatched.length > 0) {
    warnings.push({
      severity: 'notice',
      code: 'unmatched_columns',
      message:
        `These columns were not recognised and will be ignored: ${parsed.mapping.unmatched.join(', ')}.`,
      affects: parsed.mapping.unmatched,
    });
  }

  if (!parsed.mapping?.whatsappLink && parsed.rows.length > 0) {
    warnings.push({
      severity: 'notice',
      code: 'no_link_column',
      message: 'No Link column was found, so no WhatsApp links will be stored.',
      affects: [],
    });
  }

  return {
    learnerRowsRead: parsed.rows.length,
    uniqueGroups: groups.length,
    newTeams: groups.filter((g) => !g.existing).length,
    existingTeamsMatched: groups.filter((g) => g.existing).length,
    groups,
    rejected: parsed.rejected,
    warnings,
    blockers,
    // Nothing usable, or something that would create data nobody intended.
    importable: groups.length > 0 && blockers.length === 0,
  };
}

/** The rejected rows, as a file the operator can fix and re-upload. */
export function buildRejectedRowsCsv(rejected: readonly RejectedRow[]): string {
  const escape = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = ['Row,Problem,Name,Email,Group,Link'];
  for (const row of rejected) {
    lines.push(
      [
        row.rowNumber,
        escape(row.reason),
        escape(row.raw.Name ?? ''),
        escape(row.raw.Email ?? ''),
        escape(row.raw.Group ?? ''),
        escape(row.raw.Link ?? ''),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
