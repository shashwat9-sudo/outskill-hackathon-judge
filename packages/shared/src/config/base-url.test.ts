import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv, assertDistributableBaseUrl } from './env';
import { buildAccessCodeCsv, buildInviteCsv } from '../utils/csv';
import { buildSubmissionGuide } from '../content/submission-guide';

/**
 * Everything a learner is told to visit comes from `APP_BASE_URL`.
 *
 * This exists because the value was wrong in a live environment: it still read
 * `http://localhost:3000` while the server ran on another port. That string is
 * printed on **every access-code sheet** as the submission address, so every
 * team would have been sent somewhere unreachable — and nobody would find out
 * until the hackathon started.
 */

const PRODUCTION = {
  DEMO_MODE: '0',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@pooler.invalid:6543/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_not-real',
  ADMIN_SESSION_SECRET: 'x'.repeat(48),
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_BASE_URL: 'https://judge.outskill.test',
};

function problems(overrides: Record<string, string>): string[] {
  try {
    loadEnv({ ...PRODUCTION, ...overrides });
    return [];
  } catch (error) {
    return error instanceof ConfigError ? error.problems : [String(error)];
  }
}

describe('a local base URL', () => {
  it('accepts a real one at boot', () => {
    expect(loadEnv(PRODUCTION).APP_BASE_URL).toBe('https://judge.outskill.test');
  });

  it('is refused where a sheet is produced, and says why it matters', () => {
    // This used to be a boot failure. It was moved because the harm is a code
    // sheet telling teams to visit localhost, not a server running locally —
    // and refusing at boot made a real acceptance test on this machine
    // impossible while never catching a URL that turned local afterwards.
    const message = (() => {
      try {
        assertDistributableBaseUrl('http://localhost:3000');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/APP_BASE_URL/);
    expect(message).toMatch(/access-code sheet/i);
  });

  it('is refused in every local form, not just the word localhost', () => {
    for (const url of ['http://localhost:3210', 'http://127.0.0.1:3000', 'http://0.0.0.0:8080']) {
      expect(() => assertDistributableBaseUrl(url), url).toThrow(/APP_BASE_URL/);
    }
  });

  it('still allows localhost in demo mode, where it is correct', () => {
    const env = loadEnv({ DEMO_MODE: '1', APP_BASE_URL: 'http://localhost:3210' });
    expect(env.APP_BASE_URL).toBe('http://localhost:3210');
  });
});

describe('learner-facing exports carry the configured base URL', () => {
  const BASE = 'https://judge.outskill.test';

  it('puts it on every row of the access-code sheet', () => {
    const csv = buildAccessCodeCsv(
      [
        { groupNumber: 1, leadName: 'A', leadEmail: 'a@example.invalid', whatsappLink: null, memberCount: 3, code: 'ABCD-EFGH-JKMN' },
        { groupNumber: 2, leadName: 'B', leadEmail: 'b@example.invalid', whatsappLink: null, memberCount: 3, code: 'PQRS-TVWX-YZ23' },
      ],
      `${BASE}/submit`,
    );

    const rows = csv.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain(`${BASE}/submit`);
    expect(csv).not.toContain('localhost');
  });

  it('puts it in the two-day guide', () => {
    const guide = buildSubmissionGuide({
      cohortName: 'Cohort',
      deadlineLabel: 'Friday, 11:59 PM IST',
      submitUrl: `${BASE}/submit`,
    });
    const text = JSON.stringify(guide);
    expect(text).toContain(`${BASE}/submit`);

    // Narrow on purpose. The guide legitimately tells teams not to deploy to
    // localhost, so a blanket search for that word would fail on correct copy.
    // What matters is that no ADDRESS the learner is told to visit is local.
    const urls = text.match(/https?:\/\/[^"\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `guide points a learner at ${url}`).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });

  it('puts it in the legacy invite export', () => {
    const csv = buildInviteCsv([
      { groupNumber: 1, leadEmail: 'a@example.invalid', inviteUrl: `${BASE}/submit/token` },
    ]);
    expect(csv).toContain(BASE);
    expect(csv).not.toContain('localhost');
  });

  it('never hard-codes a URL of its own', () => {
    // Each builder takes the URL as an argument. A builder that reached for a
    // default would silently override the configured value.
    const csv = buildAccessCodeCsv(
      [{ groupNumber: 1, leadName: 'A', leadEmail: 'a@x.invalid', whatsappLink: null, memberCount: 3, code: 'ABCD-EFGH-JKMN' }],
      'https://somewhere-else.test/submit',
    );
    expect(csv).toContain('https://somewhere-else.test/submit');
    expect(csv).not.toContain('judge.outskill.test');
  });
});

describe('where the localhost refusal lives', () => {
  it('does not stop the application booting', async () => {
    // It used to. That made a pre-launch acceptance test — the real app, the
    // real database, this machine — impossible, while the actual harm was
    // never about the server running.
    const env = loadEnv({
      DEMO_MODE: '0',
      APP_BASE_URL: 'http://localhost:3000',
      ADMIN_SESSION_SECRET: 'x'.repeat(40),
      CREDENTIAL_ENCRYPTION_KEY: 'y'.repeat(44),
      DATABASE_URL: 'postgres://u:p@host:6543/db',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      AI_PROVIDER: 'demo',
    });
    expect(env.APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('refuses to produce anything a learner would be sent', () => {
    for (const local of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://0.0.0.0:3000',
      'http://[::1]:3000',
    ]) {
      expect(() => assertDistributableBaseUrl(local), local).toThrow(/only works on this machine/);
    }
  });

  it('allows a real address', () => {
    for (const real of ['https://judge.outskill.com', 'https://ohj.vercel.app']) {
      expect(() => assertDistributableBaseUrl(real), real).not.toThrow();
    }
  });

  it('explains that local testing is fine and sheet production is not', () => {
    const error = (() => {
      try {
        assertDistributableBaseUrl('http://localhost:3000');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(/Running locally for testing is fine/i);
  });
});

describe('the other production requirements still fail closed', () => {
  it('names each missing value, so one boot reports them all', () => {
    // Guards the relaxation above: only the localhost rule moved. Everything
    // else still refuses to start, and refuses by name rather than making an
    // operator restart once per missing variable.
    const cases: [string, RegExp][] = [
      ['ADMIN_SESSION_SECRET', /ADMIN_SESSION_SECRET/],
      ['CREDENTIAL_ENCRYPTION_KEY', /CREDENTIAL_ENCRYPTION_KEY/],
      ['DATABASE_URL', /DATABASE_URL/],
      ['SUPABASE_URL', /SUPABASE_URL/],
    ];

    for (const [key, expected] of cases) {
      const found = problems({ [key]: '' }).join(' ');
      expect(found, key).toMatch(expected);
    }
  });

  it('reports every problem at once rather than one per attempt', () => {
    const found = problems({
      ADMIN_SESSION_SECRET: '',
      CREDENTIAL_ENCRYPTION_KEY: '',
      DATABASE_URL: '',
    });
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});
