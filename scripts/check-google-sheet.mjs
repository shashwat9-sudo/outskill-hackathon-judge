/**
 * Is the Google intake wired up?
 *
 * Run before the event, with the real credential in the environment. It reports
 * whether we can authenticate, whether the sheet is shared with us, whether the
 * tab exists, and what the headers are.
 *
 * It prints header names and counts only. No cell values, so no password and no
 * learner record can appear in its output, and never the private key.
 *
 *   node scripts/check-google-sheet.mjs
 */
import { checkGoogleConnectivity, readGoogleConfig, EXPECTED_SERVICE_ACCOUNT, REQUIRED_HEADERS, normaliseHeader } from '../packages/shared/src/index.ts';

const config = readGoogleConfig(process.env);
if (!config) {
  console.error('Not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,');
  console.error('GOOGLE_SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_TAB_NAME.');
  process.exit(1);
}

const summary = await checkGoogleConnectivity(config);

console.log('service account :', summary.serviceAccountEmail);
if (!summary.matchesExpectedAccount) {
  console.log('  WARNING: this is not the expected Judge service account.');
  console.log('  expected      :', EXPECTED_SERVICE_ACCOUNT);
}
console.log('spreadsheet     :', summary.spreadsheetIdMasked);
console.log('tab             :', summary.tabName);

if (!summary.ok) {
  console.log('\nFAILED:', summary.error);
  process.exit(1);
}

console.log('data rows       :', summary.rowCount);
console.log('headers         :', summary.headers.join(' | '));

const present = summary.headers.map(normaliseHeader);
const missing = REQUIRED_HEADERS.filter((h) => !present.includes(normaliseHeader(h)));
console.log('\nrequired headers:', missing.length === 0 ? 'all present' : `MISSING → ${missing.join(', ')}`);
process.exit(missing.length === 0 ? 0 : 1);
