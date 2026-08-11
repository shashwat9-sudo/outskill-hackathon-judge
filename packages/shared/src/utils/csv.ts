/**
 * CSV parsing and generation for team import and invite export.
 *
 * Written by hand rather than pulled in as a dependency: the shapes involved
 * are small and fixed, and the formula-injection guard below matters more than
 * general-purpose parsing power.
 */

export interface CsvParseResult<T> {
  rows: T[];
  errors: { row: number; message: string }[];
  headers: string[];
}

/** RFC 4180 parsing: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const text = input.replace(/^\uFEFF/, ''); // strip BOM (escaped, not a literal)

  while (i < text.length) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

export interface TeamImportRow {
  groupNumber: number;
  leadName: string;
  leadEmail: string;
  leadPhone: string;
}

const HEADER_ALIASES: Record<keyof TeamImportRow, string[]> = {
  groupNumber: ['group number', 'group', 'group_number', 'groupno', 'group no', 'team number'],
  leadName: ['lead name', 'team lead', 'lead', 'name', 'lead_name', 'contact name'],
  leadEmail: ['lead email', 'email', 'lead_email', 'contact email', 'email address'],
  leadPhone: ['lead phone', 'phone', 'lead_phone', 'contact number', 'phone number', 'mobile'],
};

function matchHeader(header: string): keyof TeamImportRow | null {
  const normalised = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof TeamImportRow, string[]][]) {
    if (aliases.includes(normalised)) return field;
  }
  return null;
}

/**
 * Parse a team-import CSV.
 *
 * Headers are matched by alias because the historical exports used a dozen
 * different labels for the same column. Rows that cannot be parsed are
 * reported with their row number rather than silently dropped — an import that
 * quietly skips a team is worse than one that fails loudly.
 */
export function parseTeamImportCsv(input: string): CsvParseResult<TeamImportRow> {
  const raw = parseCsv(input);
  const errors: CsvParseResult<TeamImportRow>['errors'] = [];

  if (raw.length === 0) {
    return { rows: [], errors: [{ row: 0, message: 'The file is empty.' }], headers: [] };
  }

  const headerRow = raw[0] as string[];
  const headers = headerRow.map((h) => h.trim());
  const columnMap = new Map<keyof TeamImportRow, number>();
  headers.forEach((header, index) => {
    const field = matchHeader(header);
    if (field && !columnMap.has(field)) columnMap.set(field, index);
  });

  const required: (keyof TeamImportRow)[] = ['groupNumber', 'leadName', 'leadEmail', 'leadPhone'];
  const missing = required.filter((field) => !columnMap.has(field));
  if (missing.length > 0) {
    return {
      rows: [],
      headers,
      errors: [
        {
          row: 1,
          message: `Missing required column(s): ${missing.join(', ')}. Expected headers like: Group Number, Lead Name, Lead Email, Lead Phone.`,
        },
      ],
    };
  }

  const rows: TeamImportRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i] as string[];
    const rowNumber = i + 1;
    const get = (field: keyof TeamImportRow) => (cells[columnMap.get(field) as number] ?? '').trim();

    const groupRaw = get('groupNumber');
    const groupNumber = Number(groupRaw);
    if (!groupRaw) {
      errors.push({ row: rowNumber, message: 'Group number is empty.' });
      continue;
    }
    if (!Number.isInteger(groupNumber) || groupNumber < 1 || groupNumber > 999) {
      // The historical failure was an email landing in this column — say so.
      const hint = groupRaw.includes('@')
        ? ' It looks like an email address was entered in the group-number column.'
        : '';
      errors.push({ row: rowNumber, message: `"${groupRaw}" is not a group number between 1 and 999.${hint}` });
      continue;
    }

    const leadEmail = get('leadEmail');
    if (!leadEmail.includes('@') || !leadEmail.includes('.')) {
      errors.push({ row: rowNumber, message: `"${leadEmail}" is not a valid email address.` });
      continue;
    }

    rows.push({
      groupNumber,
      leadName: get('leadName'),
      leadEmail,
      leadPhone: get('leadPhone'),
    });
  }

  return { rows, errors, headers };
}

/**
 * Escape a CSV cell.
 *
 * The leading-quote guard prevents spreadsheet formula injection: a cell
 * starting with =, +, -, @, tab or CR is executed by Excel and Sheets when the
 * file is opened. Team names and emails come from user input, so this matters.
 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(text);
  const guarded = needsFormulaGuard ? `'${text}` : text;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface InviteExportRow {
  groupNumber: number;
  leadEmail: string;
  inviteUrl: string;
}

export function buildInviteCsv(rows: InviteExportRow[]): string {
  return toCsv(
    ['Group Number', 'Lead Email', 'Invite URL'],
    rows.map((r) => [r.groupNumber, r.leadEmail, r.inviteUrl]),
  );
}
