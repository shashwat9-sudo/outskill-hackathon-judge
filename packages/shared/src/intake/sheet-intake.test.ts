import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_PII_HEADERS,
  SHEET_HEADERS,
  normaliseAccessMode,
  normaliseGroupNumber,
  parseSheetRows,
  sheetSubmissionId,
} from './sheet-rows';
import { parseCsv } from '../utils/csv';

/**
 * The spreadsheet the whole event arrives on.
 *
 * A Google Sheet written by the Hackathon product, edited live by humans on the
 * day, and read once when submissions close. Everything here assumes that: that
 * columns get reordered, that people type "Open access" and "open  access", that
 * a group submits twice, and that at least one row will be missing something.
 *
 * The rules that matter most are the ones about what must *not* travel. The
 * sheet holds team leaders, members and phone numbers because the Hackathon
 * product needs them; judging does not, and a password belongs in exactly one
 * place — encrypted storage — and nowhere near a report an operator might paste
 * into a chat.
 */

const CATEGORIES = [
  { slug: 'expense-tracker', title: 'Expense Tracker' },
  { slug: 'meal-planner', title: 'Meal Planner' },
];

const row = (over: Record<string, string> = {}) => ({
  Timestamp: '2026-09-11 17:42:03',
  'Group Number': '12',
  Category: 'Expense Tracker',
  'Product Name': 'SpendWise',
  'Team Leader': 'Priya Sharma',
  'Team Members': 'Priya Sharma, Rahul Nair, Ana Costa',
  'Primary Contact': 'priya@example.invalid / +91 98765 43210',
  'MVP/Product Link': 'https://spendwise.example.com',
  Access: 'Open Access',
  'Login Email': '',
  'Login Password': '',
  'Brief Description': 'Helps people see where their money goes each month.',
  'Main User Action': 'Add their expenses and understand where most of their money is going.',
  'How AI Helps': 'It sorts each expense into a category so you do not have to.',
  'What We Got Working': 'Adding expenses, the category chart, and the monthly total.',
  'Loom Video Link': 'https://loom.com/share/abc',
  'Final Deck Link': 'https://docs.google.com/presentation/d/abc',
  ...over,
});

/** Build a sheet from objects, in whatever column order is given. */
const sheet = (rows: Record<string, string>[], headers: readonly string[] = SHEET_HEADERS) => [
  [...headers],
  ...rows.map((r) => headers.map((h) => r[h] ?? '')),
];

const parse = (rows: string[][]) => parseSheetRows(rows, { approvedCategories: CATEGORIES });

describe('finding the columns', () => {
  it('maps by header name, so reordering the sheet changes nothing', () => {
    /*
     * Someone will reorder these on the morning of the event. Position-based
     * parsing would not error — it would judge every product against the wrong
     * fields, which is far worse.
     */
    const shuffled = [...SHEET_HEADERS].reverse();
    const normal = parse(sheet([row()]));
    const reordered = parse(sheet([row()], shuffled));

    expect(reordered.valid).toHaveLength(1);
    expect(reordered.valid[0]!.input).toEqual(normal.valid[0]!.input);
  });

  it('tolerates casing, spacing and punctuation in headers', () => {
    // Same values, headers written the way a hurried human writes them.
    const values = SHEET_HEADERS.map((h) => row()[h] ?? '');
    const messy = SHEET_HEADERS.map((h) => ` ${h.toUpperCase()} `);

    expect(parse([messy, values]).valid).toHaveLength(1);
  });

  it('refuses the whole sheet when a required column is missing', () => {
    /*
     * Not row by row. A missing column affects every row equally, and ingesting
     * the rest would quietly judge a cohort on partial information.
     */
    const without = SHEET_HEADERS.filter((h) => h !== 'Main User Action');
    const result = parse(sheet([row()], without));

    expect(result.fatalError).toMatch(/missing required column/i);
    expect(result.valid).toHaveLength(0);
  });

  it('does not require Loom or deck columns, which are supporting evidence', () => {
    const without = SHEET_HEADERS.filter(
      (h) => h !== 'Loom Video Link' && h !== 'Final Deck Link',
    );
    expect(parse(sheet([row()], without)).valid).toHaveLength(1);
  });

  it('ignores blank padding rows rather than reporting them as errors', () => {
    const rows = sheet([row()]);
    rows.push(new Array(SHEET_HEADERS.length).fill(''));
    rows.push(new Array(SHEET_HEADERS.length).fill(''));

    const result = parse(rows);
    expect(result.blankRowsIgnored).toBe(2);
    expect(result.rowsRead).toBe(1);
    expect(result.invalid).toHaveLength(0);
  });
});

describe('the three new questions', () => {
  it('carries all three into the judging payload', () => {
    const [only] = parse(sheet([row()])).valid;

    expect(only!.input.mainUserAction).toContain('where most of their money is going');
    expect(only!.input.aiValue).toContain('sorts each expense');
    expect(only!.input.whatGotWorking).toContain('category chart');
  });

  it('refuses a row missing any of them', () => {
    for (const field of ['Main User Action', 'How AI Helps', 'What We Got Working']) {
      const result = parse(sheet([row({ [field]: '' })]));
      expect(result.valid, field).toHaveLength(0);
      expect(result.invalid.some((i) => i.field === field), field).toBe(true);
    }
  });
});

describe('what must never travel', () => {
  it('leaves team leader, members and contact out of the payload entirely', () => {
    /*
     * The sheet holds them; judging does not need them. A submission is "Group
     * 12" and nothing else, so none of this can reach an AI provider even by
     * accident.
     */
    const [only] = parse(sheet([row()])).valid;
    const serialised = JSON.stringify(only!.input).toLowerCase();

    for (const value of ['priya', 'rahul', 'ana costa', '98765', 'example.invalid']) {
      expect(serialised, value).not.toContain(value);
    }
    for (const header of EXCLUDED_PII_HEADERS) {
      expect(Object.keys(only!.input), header).not.toContain(header);
    }
  });

  it('keeps the password out of the payload, carrying it separately', () => {
    const result = parse(
      sheet([
        row({
          Access: 'Specific Login',
          'Login Email': 'judge@example.invalid',
          'Login Password': 'hunter2-secret',
        }),
      ]),
    );
    const [only] = result.valid;

    expect(JSON.stringify(only!.input)).not.toContain('hunter2-secret');
    expect(only!.credentials!.password).toBe('hunter2-secret');
  });

  it('never puts a password or an email in a validation message', () => {
    // An operator should be able to paste a sync report into a chat.
    const result = parse(
      sheet([
        row({
          'Product Name': '',
          Access: 'Specific Login',
          'Login Email': 'judge@example.invalid',
          'Login Password': 'hunter2-secret',
        }),
      ]),
    );
    const serialised = JSON.stringify(result.invalid);

    expect(serialised).not.toContain('hunter2-secret');
    expect(serialised).not.toContain('judge@example.invalid');
    expect(serialised).toContain('Product Name');
  });
});

describe('access mode', () => {
  it('accepts the ways a human writes the two options', () => {
    for (const value of ['Open Access', 'open access', ' OPEN  ACCESS ', 'Public', 'open']) {
      expect(normaliseAccessMode(value), value).toBe('open');
    }
    for (const value of ['Specific Login', 'specific login', 'LOGIN REQUIRED', 'credentials']) {
      expect(normaliseAccessMode(value), value).toBe('credentials');
    }
  });

  it('refuses to guess at anything else', () => {
    /*
     * Guessing sends a browser at a login wall with no credentials, or skips a
     * login the team meant — and either way a working product is scored as
     * broken.
     */
    for (const value of ['maybe', 'ask us', 'partially open', '']) {
      expect(normaliseAccessMode(value), value).toBeNull();
    }
    expect(parse(sheet([row({ Access: 'ask us on the day' })])).valid).toHaveLength(0);
  });

  it('judges an open-access product with no credentials', () => {
    const [only] = parse(sheet([row()])).valid;
    expect(only!.input.accessMode).toBe('open');
    expect(only!.credentials).toBeNull();
  });

  it('ignores stray credentials on an open-access row', () => {
    // A team filled in a box they did not need to. Storing a credential nobody
    // asked for is worse than dropping it.
    const [only] = parse(
      sheet([row({ 'Login Email': 'x@example.invalid', 'Login Password': 'unused' })]),
    ).valid;

    expect(only!.credentials).toBeNull();
    expect(JSON.stringify(only!.input)).not.toContain('unused');
  });

  it('judges a specific-login product when both credentials are present', () => {
    const [only] = parse(
      sheet([
        row({
          Access: 'Specific Login',
          'Login Email': 'judge@example.invalid',
          'Login Password': 'pw',
        }),
      ]),
    ).valid;

    expect(only!.input.accessMode).toBe('credentials');
    expect(only!.credentials).toEqual({ username: 'judge@example.invalid', password: 'pw' });
  });

  it('refuses a specific-login row that is missing them', () => {
    const result = parse(sheet([row({ Access: 'Specific Login' })]));
    expect(result.valid).toHaveLength(0);
    expect(result.invalid.map((i) => i.field)).toEqual(
      expect.arrayContaining(['Login Email', 'Login Password']),
    );
  });
});

describe('the other fields', () => {
  it('refuses a category that is not one of the approved ideas', () => {
    const result = parse(sheet([row({ Category: 'Something Else Entirely' })]));
    expect(result.valid).toHaveLength(0);
    expect(result.invalid[0]!.field).toBe('Category');
  });

  it('reads a group number however it was typed', () => {
    expect(normaliseGroupNumber('12')).toBe(12);
    expect(normaliseGroupNumber('  12 ')).toBe(12);
    expect(normaliseGroupNumber('Group 12')).toBe(12);
    expect(normaliseGroupNumber('')).toBeNull();
    expect(normaliseGroupNumber('abc')).toBeNull();
    expect(normaliseGroupNumber('1200')).toBeNull();
  });

  it('checks URLs for shape only, making no outbound request', () => {
    /*
     * A spreadsheet of learner-supplied URLs is exactly the input an SSRF
     * wants. Reachability is the worker's job, behind its egress proxy.
     */
    expect(parse(sheet([row({ 'MVP/Product Link': 'not a url' })])).valid).toHaveLength(0);
    expect(parse(sheet([row({ 'MVP/Product Link': 'ftp://x.example' })])).valid).toHaveLength(0);
    expect(parse(sheet([row({ 'Loom Video Link': 'nope' })])).valid).toHaveLength(0);
    // An absent optional link is fine.
    expect(parse(sheet([row({ 'Loom Video Link': '', 'Final Deck Link': '' })])).valid).toHaveLength(1);
  });
});

describe('a group that submitted twice', () => {
  it('is reported as a conflict and neither row is judged', () => {
    /*
     * One final submission per group is the rule. Two rows is a question we
     * cannot answer — the second might be a correction or a mistake — so a
     * human decides rather than the parser picking.
     */
    const result = parse(sheet([row(), row({ 'Product Name': 'SpendWise v2' })]));

    expect(result.duplicateGroups).toEqual([{ groupNumber: 12, rows: [2, 3] }]);
    expect(result.valid).toHaveLength(0);
  });

  it('reports only safe details about the conflict', () => {
    const result = parse(sheet([row(), row()]));
    const serialised = JSON.stringify(result.duplicateGroups);

    expect(serialised).toContain('12');
    expect(serialised).not.toContain('Priya');
    expect(serialised).not.toContain('example.invalid');
  });

  it('leaves other groups judgeable', () => {
    const result = parse(
      sheet([row(), row(), row({ 'Group Number': '13', Category: 'Meal Planner' })]),
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.groupNumber).toBe(13);
  });
});

describe('submission identity', () => {
  it('is derived from the group, not from where the row sits', () => {
    /*
     * Sheets get sorted and have rows inserted above others. Identity based on
     * row number or timestamp would make every one of those look like a new
     * submission and judge the same product again.
     */
    expect(sheetSubmissionId(12)).toBe('group-12');
    expect(sheetSubmissionId(12)).not.toContain('row');
  });

  it('is unchanged by reordering the sheet', () => {
    const first = parse(sheet([row({ 'Group Number': '12' }), row({ 'Group Number': '13', Category: 'Meal Planner' })]));
    const swapped = parse(sheet([row({ 'Group Number': '13', Category: 'Meal Planner' }), row({ 'Group Number': '12' })]));

    const ids = (r: typeof first) => r.valid.map((v) => sheetSubmissionId(v.groupNumber)).sort();
    expect(ids(swapped)).toEqual(ids(first));
  });
});

describe('the CSV fallback', () => {
  it('normalises a CSV row identically to the same Google Sheet row', () => {
    /*
     * The fallback exists for the day Google is unavailable, which is the worst
     * possible day to discover the two paths disagree. Same headers, same
     * parser, same result.
     */
    const rows = sheet([row()]);
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const fromSheet = parse(rows);
    const fromCsv = parse(parseCsv(csv));

    expect(fromCsv.valid).toHaveLength(1);
    expect(fromCsv.valid[0]!.input).toEqual(fromSheet.valid[0]!.input);
    expect(fromCsv.valid[0]!.credentials).toEqual(fromSheet.valid[0]!.credentials);
  });

  it('handles commas and quotes inside a description', () => {
    const awkward = 'Tracks spending, saves receipts, and says "you spent too much".';
    const rows = sheet([row({ 'Brief Description': awkward })]);
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    expect(parse(parseCsv(csv)).valid[0]!.input.briefDescription).toBe(awkward);
  });
});
