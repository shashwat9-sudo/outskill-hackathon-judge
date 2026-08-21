import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_PII_HEADERS,
  SHEET_HEADERS,
  normaliseAccessMode,
  normaliseGroupNumber,
  parseSheetRows,
  parseSheetTimestamp,
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

describe('a group that submitted the form twice', () => {
  /*
   * Resubmitting is ordinary. A team notices a broken link ten minutes before
   * the deadline and sends the form again — and the rule the event runs on is
   * one final submission per group, so the latest one is the final one.
   *
   * Refusing to judge either row would punish exactly the teams who were
   * paying attention.
   */

  it('judges the most recent response and records the earlier one as superseded', () => {
    const result = parse(
      sheet([
        row({ Timestamp: '2026-09-11 14:00:00', 'Product Name': 'SpendWise' }),
        row({ Timestamp: '2026-09-11 17:30:00', 'Product Name': 'SpendWise v2' }),
      ]),
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.input.productName).toBe('SpendWise v2');
    expect(result.resubmittedGroups).toEqual([
      { groupNumber: 12, selectedRow: 3, supersededRows: [2] },
    ]);
  });

  it('does not care what order the rows sit in', () => {
    // Sheets get sorted. The timestamp decides, not the position.
    const result = parse(
      sheet([
        row({ Timestamp: '2026-09-11 17:30:00', 'Product Name': 'Newest' }),
        row({ Timestamp: '2026-09-11 09:00:00', 'Product Name': 'Oldest' }),
      ]),
    );

    expect(result.valid[0]!.input.productName).toBe('Newest');
    expect(result.resubmittedGroups[0]!.selectedRow).toBe(2);
  });

  it('keeps the older working submission when the newer one is broken', () => {
    /*
     * The rule that protects a team from themselves. A later response with an
     * empty product link must not discard an earlier complete one — otherwise a
     * team that resubmitted badly would be judged on nothing at all.
     */
    const result = parse(
      sheet([
        row({ Timestamp: '2026-09-11 14:00:00', 'Product Name': 'Working' }),
        row({ Timestamp: '2026-09-11 17:30:00', 'MVP/Product Link': '' }),
      ]),
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.input.productName).toBe('Working');

    const group = result.resubmittedGroups[0]!;
    expect(group.selectedRow).toBe(2);
    expect(group.newestRejected?.row).toBe(3);
    expect(group.newestRejected?.reason).toMatch(/MVP\/Product Link/);
  });

  it('creates exactly one submission for a group however many times they submitted', () => {
    const result = parse(
      sheet([row({ Timestamp: '2026-09-11 09:00:00' }), row({ Timestamp: '2026-09-11 12:00:00' }), row({ Timestamp: '2026-09-11 17:00:00' })]),
    );

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.row).toBe(4);
    expect(result.resubmittedGroups[0]!.supersededRows).toEqual([3, 2]);
  });

  it('falls back to sheet order when timestamps are missing', () => {
    // Google Forms appends, so a later row is a later submission. Inventing a
    // date would decide this silently.
    const result = parse(
      sheet([
        row({ Timestamp: '', 'Product Name': 'First' }),
        row({ Timestamp: '', 'Product Name': 'Second' }),
      ]),
    );

    expect(result.valid[0]!.input.productName).toBe('Second');
  });

  it('prefers a row whose timestamp can be read over one whose cannot', () => {
    const result = parse(
      sheet([
        row({ Timestamp: 'not a date at all', 'Product Name': 'Unreadable' }),
        row({ Timestamp: '2026-09-11 10:00:00', 'Product Name': 'Readable' }),
      ]),
    );

    expect(result.valid[0]!.input.productName).toBe('Readable');
  });

  it('reports only safe details about the resubmission', () => {
    const result = parse(sheet([row(), row()]));
    const serialised = JSON.stringify(result.resubmittedGroups);

    expect(serialised).toContain('12');
    expect(serialised).not.toContain('Priya');
    expect(serialised).not.toContain('example.invalid');
  });

  it('leaves other groups untouched', () => {
    const result = parse(
      sheet([row(), row(), row({ 'Group Number': '13', Category: 'Meal Planner' })]),
    );

    expect(result.valid).toHaveLength(2);
    expect(result.valid.map((v) => v.groupNumber).sort()).toEqual([12, 13]);
  });
});

describe('reading the timestamp', () => {
  it('understands the shape Google Forms writes', () => {
    expect(parseSheetTimestamp('2026-09-11 17:42:03')?.toISOString()).toContain('2026-09-11');
    expect(parseSheetTimestamp('2026-09-11T17:42:03')?.toISOString()).toContain('2026-09-11');
  });

  it('returns null rather than guessing at something unreadable', () => {
    for (const bad of ['', '   ', 'yesterday', 'not a date']) {
      expect(parseSheetTimestamp(bad), bad).toBeNull();
    }
  });
});

describe('header aliases', () => {
  it('accepts a reworded column for a canonical one', () => {
    // Same question, different words. The production headers stay canonical.
    const headers = SHEET_HEADERS.map((h) =>
      h === 'MVP/Product Link' ? 'Product URL' : h === 'Group Number' ? 'Group' : h,
    );
    const values = SHEET_HEADERS.map((h) => row()[h] ?? '');

    const result = parse([headers, values]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]!.input.productUrl).toBe('https://spendwise.example.com');
  });

  it('still fails closed on a column it does not recognise', () => {
    const headers = SHEET_HEADERS.map((h) => (h === 'Main User Action' ? 'Some Other Question' : h));
    const values = SHEET_HEADERS.map((h) => row()[h] ?? '');

    expect(parse([headers, values]).fatalError).toMatch(/missing required column/i);
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
