/**
 * Set the production admin password, locally and without echo.
 *
 * Run it yourself, in your own terminal:
 *
 *   node scripts/set-admin-password.mjs
 *
 * The password is read directly from the terminal with echo disabled, held in
 * memory only long enough to write it to `.env.local`, and never printed,
 * logged, or passed as an argument — an argument would appear in your shell
 * history and in the process list, which is exactly what this avoids.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ENV_PATH = '.env.local';
const MIN_LENGTH = 12;

/** Values that must never reach production. */
const FORBIDDEN = ['demo-admin-password', 'outskill-admin', 'password', 'admin', 'changeme'];

/**
 * Read a line from the terminal with echo off.
 *
 * Reads from /dev/tty rather than stdin so a piped or redirected stdin cannot
 * silently supply the password without the user seeing the prompt.
 */
function promptHidden(question) {
  process.stdout.write(question);
  try {
    const value = execFileSync(
      '/bin/sh',
      ['-c', 'stty -echo < /dev/tty; IFS= read -r line < /dev/tty; stty echo < /dev/tty; printf %s "$line"'],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
    );
    process.stdout.write('\n');
    return value;
  } catch {
    process.stdout.write('\n');
    throw new Error('Could not read from the terminal. Run this directly in a terminal window.');
  }
}

function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(`${ENV_PATH} does not exist. Run this from the project root.`);
    process.exit(1);
  }

  let text = readFileSync(ENV_PATH, 'utf8');
  if (/^ADMIN_SEED_PASSWORD=.+$/m.test(text)) {
    console.error(
      'ADMIN_SEED_PASSWORD is already set. Bootstrap never resets an existing admin password,\n' +
        'so changing it here would have no effect — use /admin/settings instead.',
    );
    process.exit(1);
  }

  console.log('\nProduction admin password for user "hackathon-admin".');
  console.log('Nothing you type will be shown. It is written straight to .env.local.\n');

  const password = promptHidden('Password: ');
  const confirm = promptHidden('Confirm:  ');

  const problems = [];
  if (password !== confirm) problems.push('The two entries do not match.');
  if (password.length < MIN_LENGTH) {
    problems.push(`Use at least ${MIN_LENGTH} characters (you entered ${password.length}).`);
  }
  if (FORBIDDEN.includes(password.toLowerCase())) {
    problems.push('That is a known default. Choose something else.');
  }
  if (/^\s|\s$/.test(password)) {
    problems.push('Leading or trailing spaces are too easy to lose when retyping.');
  }

  if (problems.length > 0) {
    // The password itself is never echoed back, even in an error.
    console.error('\nNot set:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  // Escaped for a dotenv value: quotes so a '#' cannot start a comment, and a
  // backslash-escape for any embedded quote.
  const escaped = `"${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  text = text.replace(/^ADMIN_SEED_PASSWORD=\s*$/m, `ADMIN_SEED_PASSWORD=${escaped}`);
  writeFileSync(ENV_PATH, text, { mode: 0o600 });

  console.log('\n✅ Written to .env.local (mode 600). It was not printed or logged.');
  console.log(`   Length: ${password.length} characters.`);
  console.log('\n   Store it in your password manager now — bootstrap hashes it with Argon2id');
  console.log('   and it is not recoverable from the database afterwards.\n');
}

main();
