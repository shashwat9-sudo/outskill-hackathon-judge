import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SyncReport } from '@ohj/shared';
import { IntakeControl } from './intake-control';
import type { IntakeConfig } from '@/server/intake-actions';

/**
 * What the operator sees.
 *
 * The person using this is a programme operator, not an engineer: they fix
 * problems by opening the spreadsheet and typing. So the tests are about
 * whether the screen says something actionable, and about the two things that
 * must never appear on it — a password and a learner's contact details, on a
 * screen that will be shared in a room.
 */

vi.mock('@/server/intake-actions', async () => ({
  testConnectionAction: vi.fn(),
  dryRunAction: vi.fn(),
  syncAction: vi.fn(),
}));

const config: IntakeConfig = {
  configured: true,
  serviceAccountEmail: 'outskill-hackathon-judge@outskill-hackathon-judge.iam.gserviceaccount.com',
  expectedServiceAccount: 'outskill-hackathon-judge@outskill-hackathon-judge.iam.gserviceaccount.com',
  externalCohortId: 'AIAP-C13',
  cohortName: 'AI Accelerator Cohort 13',
  tabName: 'Form Responses 1',
  spreadsheetIdMasked: 'sheet-…3456',
  missing: [],
};

describe('before anything has been run', () => {
  it('shows the three steps in the order they are used', () => {
    render(<IntakeControl config={config} />);

    expect(screen.getByText(/1\. Test connection/)).toBeTruthy();
    expect(screen.getByText(/2\. Check the sheet/)).toBeTruthy();
    expect(screen.getByText(/3\. Import final submissions/)).toBeTruthy();
  });

  it('says plainly that checking imports nothing', () => {
    render(<IntakeControl config={config} />);
    expect(screen.getByText(/does not import submissions or start judging/i)).toBeTruthy();
  });

  it('will not let anyone import before checking', () => {
    // Blind import is the mistake this whole screen is arranged to prevent.
    render(<IntakeControl config={config} />);

    expect(screen.getByText(/Check the sheet first/i)).toBeTruthy();
    expect(screen.queryByText(/Confirm & import/i)).toBeNull();
  });

  it('shows the configuration without the private key', () => {
    render(<IntakeControl config={config} />);
    const body = document.body.textContent ?? '';

    expect(body).toContain('AI Accelerator Cohort 13');
    expect(body).toContain('sheet-…3456');
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).not.toContain('BEGIN');
  });

  it('names what is missing when configuration is incomplete', () => {
    render(
      <IntakeControl
        config={{ ...config, configured: false, missing: ['Spreadsheet ID', 'Cohort ID'] }}
      />,
    );
    expect(screen.getByText(/Spreadsheet ID, Cohort ID/)).toBeTruthy();
  });
});

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  spreadsheetId: 'sheet-…3456',
  tabName: 'Form Responses 1',
  externalCohortId: 'AIAP-C13',
  judgeCohortId: 'uuid-1',
  rowsRead: 6,
  blankRowsIgnored: 2,
  validRows: 3,
  invalidRows: 2,
  resubmittedGroups: [{ groupNumber: 33, selectedRow: 47, supersededRows: [42] }],
  newSubmissions: 0,
  alreadyIngested: 0,
  jobsQueued: 0,
  errors: [],
  fingerprint: 'abc123',
  changedSinceSync: [],
  dryRun: true,
  groups: [
    { row: 2, groupNumber: 12, productName: 'SpendWise', category: 'expense-tracker', status: 'ready' },
    { row: 3, groupNumber: 14, productName: '—', category: '—', status: 'blocked', issue: 'MVP/Product Link — Missing.' },
    { row: 4, groupNumber: 21, productName: '—', category: '—', status: 'blocked', issue: 'Login Password — Required when Access is "Specific Login".' },
    { row: 42, groupNumber: 33, productName: '—', category: '—', status: 'superseded', issue: 'Replaced by a later submission on row 47. Not imported.' },
  ],
  ...over,
});

/** Run a dry run through the UI and wait for it to land. */
async function afterDryRun(result: SyncReport) {
  const actions = await import('@/server/intake-actions');
  vi.mocked(actions.dryRunAction).mockResolvedValue({ ranAt: '2026-09-11T18:00:00Z', report: result });

  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  render(<IntakeControl config={config} />);
  await user.click(screen.getByRole('button', { name: /check the sheet/i }));
  return user;
}

describe('after checking the sheet', () => {
  it('shows counts an operator can act on', async () => {
    await afterDryRun(report());

    // "Ready to import" is both a stat label and a row badge, so both appear.
    expect((await screen.findAllByText('Ready to import')).length).toBeGreaterThan(0);
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Resubmitted groups')).toBeTruthy();
    expect(screen.getByText('Blank rows skipped')).toBeTruthy();
  });

  it('explains each problem in plain language, by group', async () => {
    /*
     * The person reading this fixes it by opening the spreadsheet. "Group 14 —
     * MVP/Product Link — Missing" is actionable; a stack trace is not.
     */
    await afterDryRun(report());

    expect(await screen.findByText(/MVP\/Product Link — Missing/)).toBeTruthy();
    expect(screen.getByText(/Login Password — Required when Access is/)).toBeTruthy();
    expect(screen.getByText(/Replaced by a later submission on row 47/)).toBeTruthy();
  });

  it('never renders a password or learner contact details', async () => {
    // This screen gets shared. Nothing on it should be a secret.
    await afterDryRun(report());
    await screen.findAllByText('Ready to import');

    const body = document.body.textContent ?? '';
    for (const forbidden of ['hunter2', 'Login Password:', '@example.invalid', 'Priya', '98765']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('offers an import naming the exact number, and asks again before doing it', async () => {
    const user = await afterDryRun(report());

    const start = await screen.findByRole('button', { name: /Import 1 submission…/ });
    await user.click(start);

    expect(screen.getByText(/Import final submissions\?/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirm & import 1 submission/ })).toBeTruthy();
    // And it says what will be left behind, rather than importing quietly.
    expect(screen.getByText(/Fix them in the sheet/i)).toBeTruthy();
    expect(screen.getByText(/treat submissions as final once imported/i)).toBeTruthy();
  });

  it('offers no import when nothing is ready', async () => {
    await afterDryRun(report({ groups: [] }));
    expect(await screen.findByText(/Nothing new to import/i)).toBeTruthy();
  });

  it('warns when an imported group has since changed in the sheet', async () => {
    await afterDryRun(
      report({
        changedSinceSync: [{ groupNumber: 12, row: 2 }],
        groups: [
          {
            row: 2,
            groupNumber: 12,
            productName: 'SpendWise',
            category: 'expense-tracker',
            status: 'changed_since_sync',
            issue: 'Already imported, but the Sheet has changed since. Not re-imported.',
          },
        ],
      }),
    );

    expect(await screen.findByText(/have changed in the sheet/i)).toBeTruthy();
    expect(screen.getAllByText(/not re-imported/i).length).toBeGreaterThan(0);
  });

  it('reports a sheet it could not read, without a stack trace', async () => {
    await afterDryRun(report({ fatalError: 'The sheet is missing required column(s): How AI Helps.' }));

    expect(await screen.findByText(/missing required column/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('at Object.');
  });
});

describe('after importing', () => {
  it('says judging has not started and offers the next places to look', async () => {
    /*
     * Queueing is not judging. Railway is a separate, deliberately manual
     * decision, and the screen should not imply otherwise.
     */
    const actions = await import('@/server/intake-actions');
    vi.mocked(actions.dryRunAction).mockResolvedValue({ ranAt: 'x', report: report() });
    vi.mocked(actions.syncAction).mockResolvedValue({
      ranAt: 'x',
      report: report({ dryRun: false, newSubmissions: 1, jobsQueued: 1, alreadyIngested: 0 }),
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<IntakeControl config={config} />);

    await user.click(screen.getByRole('button', { name: /check the sheet/i }));
    await user.click(await screen.findByRole('button', { name: /Import 1 submission…/ }));
    await user.click(screen.getByRole('button', { name: /Confirm & import/ }));

    expect(await screen.findByText(/Judging has not started yet/i)).toBeTruthy();
    expect(screen.getByText(/judging worker must be online/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /View submissions/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /View judging status/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /View shortlist/i })).toBeTruthy();
  });

  it('surfaces a refused import when the sheet moved underneath', async () => {
    const actions = await import('@/server/intake-actions');
    vi.mocked(actions.dryRunAction).mockResolvedValue({ ranAt: 'x', report: report() });
    vi.mocked(actions.syncAction).mockResolvedValue({
      ranAt: 'x',
      report: report({
        dryRun: false,
        fatalError:
          'The Sheet has changed since the last Dry Run. Run Dry Run again and review the new results before syncing.',
      }),
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<IntakeControl config={config} />);

    await user.click(screen.getByRole('button', { name: /check the sheet/i }));
    await user.click(await screen.findByRole('button', { name: /Import 1 submission…/ }));
    await user.click(screen.getByRole('button', { name: /Confirm & import/ }));

    expect(await screen.findByText(/changed since the last Dry Run/i)).toBeTruthy();
  });
});
