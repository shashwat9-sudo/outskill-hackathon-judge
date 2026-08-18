import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoCredentialShapedContent, redactDeep } from '@ohj/ai';

/**
 * A participant's demo credentials, and where they are allowed to exist.
 *
 * A team hands over a working login so their product can be tested. That is a
 * real credential to a real system, given to us on trust, and the only place it
 * is ever needed is the instant a browser fills a form.
 *
 * So it may exist in exactly two places: encrypted at rest, and in worker
 * memory during browser execution. It must never reach an AI prompt, an AI
 * response, a log line, a trace, an evidence record, a screenshot, a ranking, a
 * feedback report or an export.
 *
 * This was not always true. The artifact-analysis stage used to decrypt the
 * credential purely to assert it was absent from the AI payload — which put the
 * plaintext in memory at the exact moment a payload was being assembled, so a
 * throw between those two lines could have written it into a stack trace. The
 * check has been replaced with a structural guarantee, and these tests are what
 * hold that guarantee in place.
 */

const WORKER = dirname(fileURLToPath(import.meta.url));

async function source(file: string): Promise<string> {
  return readFile(resolve(WORKER, file), 'utf8');
}

/** Statements, with comments removed — prose about credentials is not a leak. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Everything between an AI stage's opening line and its next stage boundary. */
async function pipelineCode(): Promise<string> {
  return code(await source('pipeline.ts'));
}

// --------------------------------------------------------------------------

describe('decryption happens once, at the browser', () => {
  it('is called from exactly one stage', async () => {
    // Every additional call site is another window in which plaintext exists.
    const text = await pipelineCode();
    const calls = [...text.matchAll(/revealCredentials\(/g)];
    expect(calls).toHaveLength(1);
  });

  it('is not called by the artifact-analysis stage', async () => {
    // The regression this file exists for.
    const text = await pipelineCode();
    const stageStart = text.indexOf('async function artifactAnalysisStage');
    const stageEnd = text.indexOf('async function testPlanStage');
    expect(stageStart).toBeGreaterThan(-1);
    expect(stageEnd).toBeGreaterThan(stageStart);

    expect(text.slice(stageStart, stageEnd)).not.toContain('revealCredentials');
  });

  it('is not called by the test-plan stage either', async () => {
    const text = await pipelineCode();
    const start = text.indexOf('async function testPlanStage');
    const end = text.indexOf('async function browserTestingStage');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    expect(text.slice(start, end)).not.toContain('revealCredentials');
  });

  it('uses ciphertext metadata where it only needs to know one exists', async () => {
    // Preflight asks "did they supply credentials?", which is answerable from
    // the ciphertext without decrypting anything.
    const text = await pipelineCode();
    expect(text).toMatch(/getCredentials\(/);
    expect(text).toMatch(/hasCredentials: Boolean\(credentials\?\.passwordCiphertext\)/);
  });
});

describe('no AI call receives a credential', () => {
  it('passes no credential field to any ai.run payload', async () => {
    const text = await pipelineCode();

    // Every ai.run(...) call, sliced from its opening to the matching close.
    const calls: string[] = [];
    let index = text.indexOf('ai.run(');
    while (index !== -1) {
      let depth = 0;
      let end = index;
      for (let i = index; i < text.length; i += 1) {
        if (text[i] === '(') depth += 1;
        if (text[i] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      calls.push(text.slice(index, end + 1));
      index = text.indexOf('ai.run(', end);
    }

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'an ai.run payload references credentials').not.toMatch(
        /\bcredentials\b|\bpassword\b|\busername\b/i,
      );
    }
  });

  it('describes the login symbolically instead', async () => {
    // The model needs to know a login is required in order to plan around it.
    // It does not need the login.
    const text = await pipelineCode();
    expect(text).toMatch(/loginRequired: detail\.submission\.loginRequired/);
  });

  it('substitutes the real values only at execution time', async () => {
    const executor = code(await source('executor.ts'));
    expect(executor).toMatch(/Substitute credential placeholders at execution time|replaceAll\(CREDENTIAL_/);
  });
});

describe('the payload assertion no longer needs the plaintext', () => {
  it('takes only the payload', async () => {
    const text = await pipelineCode();
    expect(text).toMatch(/assertNoCredentialShapedContent\(\{[^)]*\}\)/);
    expect(text).not.toMatch(/assertNoCredentials\(/);
  });

  it('still catches a credential a participant typed into a free-text field', () => {
    // The case a structural allowlist genuinely cannot catch: the participant
    // put it somewhere it was never meant to be.
    for (const payload of [
      { written: 'Log in with password: hunter2sup' },
      { written: 'Try https://admin:letmein@demo.example.com' },
      { written: 'Send header Bearer abcdefghijklmnopqrstuvwxyz012345' },
      { written: 'Our key is sk-abcdefghijklmnop0123' },
    ]) {
      expect(() => assertNoCredentialShapedContent(payload), JSON.stringify(payload)).toThrow(
        /Refusing to send/,
      );
    }
  });

  it('does not fire on ordinary text about logins', () => {
    // A false positive here fails a real submission for describing itself.
    for (const payload of [
      { written: 'The app requires a password to sign in.' },
      { written: 'Users authenticate with email and password.' },
      { written: 'We hash passwords with bcrypt.' },
    ]) {
      expect(() => assertNoCredentialShapedContent(payload), JSON.stringify(payload)).not.toThrow();
    }
  });
});

describe('redaction before the boundary', () => {
  it('removes a credential embedded in a URL', () => {
    const result = redactDeep({ url: 'https://admin:s3cret@demo.example.com/app' });
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it('removes an email a participant typed into a description', () => {
    const result = redactDeep({ note: 'Contact priya@example.com for access' });
    expect(JSON.stringify(result)).not.toContain('priya@example.com');
  });

  it('removes a phone number', () => {
    const result = redactDeep({ note: 'Call +91 98765 43210' });
    expect(JSON.stringify(result)).not.toContain('98765');
  });

  it('removes a known team name when told about it', () => {
    const result = redactDeep({ note: 'Built by Priya Sharma and Arjun Rao' }, [
      'Priya Sharma',
      'Arjun Rao',
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain('Priya');
    expect(text).not.toContain('Arjun');
  });

  it('leaves the substance of a submission intact', () => {
    // Redaction that removed the content would make judging meaningless.
    const result = redactDeep({
      note: 'A booking tool for small clinics that reduces no-shows with reminders.',
    });
    expect(JSON.stringify(result)).toContain('booking tool for small clinics');
  });
});

describe('what a log line may contain', () => {
  it('never a credential field', async () => {
    const text = await pipelineCode();
    const logCalls = [...text.matchAll(/log\.(?:info|warn|error|debug)\([^;]*\)/g)].map((m) => m[0]);

    for (const call of logCalls) {
      expect(call, 'a log call references a credential').not.toMatch(
        /credentials\.(?:username|password)|\bpassword:\s*[^m]/i,
      );
    }
  });

  it('masks credential values that a product echoes into its own console', async () => {
    // A submitted product that logs its own login form would otherwise put a
    // third party's credential into our evidence.
    const executor = code(await source('executor.ts'));
    expect(executor).toMatch(/MASK|masked/);
  });
});

describe('the guard does not fire on its own success', () => {
  it('accepts text that redaction has already scrubbed', () => {
    // Found by the first real controlled run: redaction turns
    // "password: Hunter2Reminder" into "password: [REMOVED]", which matched the
    // labelled-password pattern. Every submission that mentioned a password
    // would have been refused, and the failure would have read as a leak.
    for (const payload of [
      { written: 'Demo login: username [EMAIL REMOVED] password: [REMOVED]' },
      { written: 'Contact [EMAIL REMOVED] or [PHONE REMOVED]' },
      { written: 'Built by [NAME REMOVED] and [NAME REMOVED]' },
      { url: 'https://[CREDENTIALS REMOVED]@demo.example.com' },
    ]) {
      expect(() => assertNoCredentialShapedContent(payload), JSON.stringify(payload)).not.toThrow();
    }
  });

  it('still catches a real credential sitting next to a redacted one', () => {
    // The marker must not become a way to smuggle something past the check.
    expect(() =>
      assertNoCredentialShapedContent({
        written: 'user: [EMAIL REMOVED] password: actualLeakedSecret123',
      }),
    ).toThrow(/Refusing to send/);
  });
});

describe('the labelled-password pattern stays on one line', () => {
  it('does not read the next sentence as the password', () => {
    // Also found by the first controlled run. After the value was redacted the
    // pattern spanned the newline and matched the following word, so a clean
    // payload was refused with a message claiming a credential was present.
    expect(() =>
      assertNoCredentialShapedContent({
        written: 'Demo login: password: [REMOVED]\nreminder scheduling is approximate',
      }),
    ).not.toThrow();
  });

  it('still catches a password given on its own line', () => {
    expect(() =>
      assertNoCredentialShapedContent({ written: 'password: SuperSecret99\nnext line' }),
    ).toThrow(/Refusing to send/);
  });
});
