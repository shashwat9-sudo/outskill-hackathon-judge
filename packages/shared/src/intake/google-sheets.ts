import { createSign } from 'node:crypto';
import type { SheetSource } from './sheet-sync';

/**
 * Reading the submissions sheet, and nothing else.
 *
 * A dedicated service account with Viewer access to one spreadsheet, using the
 * narrowest scope Google offers for this — `spreadsheets.readonly`. Not Drive:
 * Drive scopes would grant reach over every file the account can see, and this
 * account needs exactly one.
 *
 * The credential lives in server environment variables and nowhere else. There
 * is no JSON file in the repository, nothing is bundled for a browser, and the
 * private key is never logged, never echoed into an error and never returned by
 * any endpoint. Railway does not need any of this — the worker judges products
 * and never reads the sheet.
 *
 * v1 is read-only in the strong sense: the account has Viewer permission and
 * this client has no code that could write. Scores stay in the Judge, and no
 * column is ever added to a learner's row.
 */

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** The identity we expect to be. Documented so a wrong key fails loudly. */
export const EXPECTED_SERVICE_ACCOUNT =
  'outskill-hackathon-judge@outskill-hackathon-judge.iam.gserviceaccount.com';

export interface GoogleSheetsConfig {
  serviceAccountEmail: string;
  /** PEM. Environment variables usually carry it with escaped newlines. */
  privateKey: string;
  spreadsheetId: string;
  tabName: string;
}

export class GoogleSheetsError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'not_configured'
      | 'auth_failed'
      | 'forbidden'
      | 'not_found'
      | 'missing_tab'
      | 'rate_limited'
      | 'unavailable',
  ) {
    super(message);
    this.name = 'GoogleSheetsError';
  }
}

/**
 * Restore a PEM that has travelled through an environment variable.
 *
 * Almost every deployment platform stores this with literal `\n` sequences
 * rather than real newlines, and a PEM with the wrong line breaks fails to sign
 * with an error that says nothing about why. Surrounding quotes get stripped
 * too, because a copy-paste usually brings them along.
 */
export function normalisePrivateKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n');
}

export function readGoogleConfig(
  env: Record<string, string | undefined>,
): GoogleSheetsConfig | null {
  const serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const tabName = env.GOOGLE_SHEETS_TAB_NAME?.trim();

  if (!serviceAccountEmail || !rawKey || !spreadsheetId || !tabName) return null;
  return {
    serviceAccountEmail,
    privateKey: normalisePrivateKey(rawKey),
    spreadsheetId,
    tabName,
  };
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A short-lived access token for one scope.
 *
 * Signed JWT rather than a stored refresh token: the assertion lives for an
 * hour, is scoped to reading spreadsheets, and there is nothing durable to leak.
 */
async function getAccessToken(
  config: GoogleSheetsConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.serviceAccountEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signature = base64url(signer.sign(config.privateKey));
  } catch {
    /*
     * The error from `sign` can quote the key material. It is replaced with a
     * message that says what to check and nothing about what we hold.
     */
    throw new GoogleSheetsError(
      'The Google service-account private key could not be used to sign. Check that ' +
        'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY contains the full PEM, including the BEGIN and END lines.',
      'auth_failed',
    );
  }

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }).toString(),
  });

  if (!response.ok) {
    // Google's body can echo the assertion. Only the status is surfaced.
    throw new GoogleSheetsError(
      `Google refused the service-account credential (HTTP ${response.status}). Check the ` +
        'service-account email and private key, and that the Google Sheets API is enabled.',
      'auth_failed',
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new GoogleSheetsError('Google returned no access token.', 'auth_failed');
  }
  return body.access_token;
}

/** Turn a Sheets API failure into something an operator can act on. */
function describeFailure(status: number, spreadsheetId: string): GoogleSheetsError {
  if (status === 401)
    return new GoogleSheetsError(
      'Google rejected the credential (401). The key may have been rotated or revoked.',
      'auth_failed',
    );
  if (status === 403)
    return new GoogleSheetsError(
      `The service account cannot read this spreadsheet (403). Share ${spreadsheetId} with ` +
        `${EXPECTED_SERVICE_ACCOUNT} as a Viewer, and confirm the Google Sheets API is enabled.`,
      'forbidden',
    );
  if (status === 404)
    return new GoogleSheetsError(
      'No spreadsheet with that id (404). Check GOOGLE_SHEETS_SPREADSHEET_ID.',
      'not_found',
    );
  if (status === 429)
    return new GoogleSheetsError('Google rate-limited the request (429). Try again shortly.', 'rate_limited');
  return new GoogleSheetsError(`Google Sheets is unavailable (HTTP ${status}).`, 'unavailable');
}

export function googleSheetsSource(
  config: GoogleSheetsConfig,
  fetchImpl: typeof fetch = fetch,
): SheetSource {
  return {
    describe: () => ({
      kind: 'google_sheets',
      spreadsheetId: config.spreadsheetId,
      tabName: config.tabName,
    }),

    async read() {
      const token = await getAccessToken(config, fetchImpl);
      const range = encodeURIComponent(config.tabName);
      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}` +
        `/values/${range}?majorDimension=ROWS`;

      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 400) {
          // Sheets answers 400 for a range naming a tab that is not there.
          throw new GoogleSheetsError(
            `No tab named "${config.tabName}" in that spreadsheet. Check GOOGLE_SHEETS_TAB_NAME.`,
            'missing_tab',
          );
        }
        throw describeFailure(response.status, config.spreadsheetId);
      }

      const body = (await response.json()) as { values?: string[][] };
      return body.values ?? [];
    },
  };
}

export interface ConnectivitySummary {
  ok: boolean;
  serviceAccountEmail: string;
  matchesExpectedAccount: boolean;
  spreadsheetIdMasked: string;
  tabName: string;
  headers: string[];
  rowCount: number;
  error?: string;
}

/**
 * A diagnostic an operator can run before the event.
 *
 * Reports whether we can authenticate, whether the sheet is shared, whether the
 * tab exists and what the headers are. It returns header names and counts — no
 * cell values, so no password and no learner record can appear in its output.
 */
export async function checkGoogleConnectivity(
  config: GoogleSheetsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivitySummary> {
  const masked =
    config.spreadsheetId.length > 10
      ? `${config.spreadsheetId.slice(0, 6)}…${config.spreadsheetId.slice(-4)}`
      : '…';

  const base: ConnectivitySummary = {
    ok: false,
    serviceAccountEmail: config.serviceAccountEmail,
    matchesExpectedAccount: config.serviceAccountEmail === EXPECTED_SERVICE_ACCOUNT,
    spreadsheetIdMasked: masked,
    tabName: config.tabName,
    headers: [],
    rowCount: 0,
  };

  try {
    const rows = await googleSheetsSource(config, fetchImpl).read();
    return {
      ...base,
      ok: true,
      headers: (rows[0] ?? []).map((h) => String(h).trim()),
      // Data rows, excluding the header.
      rowCount: Math.max(0, rows.length - 1),
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : 'Could not reach Google Sheets.',
    };
  }
}
