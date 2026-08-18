import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_BUCKETS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_UPLOAD_TTL_SECONDS,
  evidencePathBelongsTo,
  evidenceTarget,
  isEvidenceKind,
  sanitiseEvidenceFilename,
} from './evidence-path';

/**
 * The one thing the worker must not be able to choose.
 *
 * The worker holds no Storage credential; it asks for permission to write a
 * single object and the server decides which. Everything here is about that
 * decision being unforgeable — because if a worker can name its own
 * destination, the credential boundary bought us nothing.
 */

const OWNER = {
  cohortId: '11111111-1111-4111-8111-111111111111',
  submissionId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
};

const OTHER = {
  cohortId: '11111111-1111-4111-8111-111111111111',
  submissionId: '99999999-9999-4999-8999-999999999999',
  jobId: '88888888-8888-4888-8888-888888888888',
};

describe('the path the server derives', () => {
  it('puts evidence under the cohort, submission and job it belongs to', () => {
    const target = evidenceTarget(OWNER, 'trace', 'desktop.zip');
    expect(target.bucket).toBe('traces');
    expect(target.storagePath).toBe(
      `${OWNER.cohortId}/${OWNER.submissionId}/${OWNER.jobId}/trace/desktop.zip`,
    );
  });

  it('keeps the submission id in the second segment, where the RLS policy reads it', () => {
    // Migration 0003 checks `(storage.foldername(name))[2]`. A path shaped any
    // other way is refused by Postgres as well as here, and both matter.
    const { storagePath } = evidenceTarget(OWNER, 'screenshot', 'step-3.png');
    expect(storagePath.split('/')[1]).toBe(OWNER.submissionId);
  });

  it('sends each kind to its own private bucket', () => {
    expect(evidenceTarget(OWNER, 'screenshot', 'a.png').bucket).toBe('submission-screenshots');
    expect(evidenceTarget(OWNER, 'trace', 'a.zip').bucket).toBe('traces');
    expect(evidenceTarget(OWNER, 'artifact', 'a.json').bucket).toBe('browser-evidence');
    // And nothing else is an evidence bucket. `submission-decks` is a
    // participant-writable bucket and must never appear here.
    expect(Object.values(EVIDENCE_BUCKETS)).not.toContain('submission-decks');
  });

  it('refuses to build a path from anything that is not a uuid', () => {
    for (const bad of ['', '../etc', 'not-a-uuid', '33333333-3333-4333-8333-33333333333']) {
      expect(() => evidenceTarget({ ...OWNER, jobId: bad }, 'trace', 'a.zip')).toThrow(/uuid/);
    }
  });
});

describe('the filename, the only caller input', () => {
  it('cannot climb out of its prefix', () => {
    for (const hostile of [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '/absolute/path.zip',
      'nested/dir/file.zip',
    ]) {
      const name = sanitiseEvidenceFilename(hostile);
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
    }
  });

  it('drops a null byte rather than truncating around it', () => {
    expect(sanitiseEvidenceFilename('trace\0.zip')).toBe('trace.zip');
  });

  it('never returns an empty name', () => {
    for (const empty of ['', '...', '///', '\0']) {
      expect(sanitiseEvidenceFilename(empty).length).toBeGreaterThan(0);
    }
  });

  it('is idempotent, so a sanitised name survives the confirmation check', () => {
    // Confirmation re-derives the name. If sanitising twice changed it, every
    // upload with an awkward filename would be refused at the last step.
    for (const name of ['desktop.zip', 'step-3.png', 'weird name!.png', '../x.png']) {
      const once = sanitiseEvidenceFilename(name);
      expect(sanitiseEvidenceFilename(once)).toBe(once);
    }
  });
});

describe('confirming a path the worker echoed back', () => {
  const good = evidenceTarget(OWNER, 'trace', 'desktop.zip');

  it('accepts exactly the path that was issued', () => {
    expect(evidencePathBelongsTo(good.storagePath, good.bucket, OWNER, 'trace')).toBe(true);
  });

  it('refuses another job’s evidence path', () => {
    const theirs = evidenceTarget(OTHER, 'trace', 'desktop.zip');
    expect(evidencePathBelongsTo(theirs.storagePath, theirs.bucket, OWNER, 'trace')).toBe(false);
  });

  it('refuses a path that merely starts correctly', () => {
    /*
     * Why this is checked by reconstruction rather than by prefix.
     *
     * A `startsWith` test accepts the string below — it begins with exactly the
     * right cohort, submission and job — and it resolves somewhere else
     * entirely. Prefix matching is the intuitive check and the wrong one.
     */
    const traversal = `${OWNER.cohortId}/${OWNER.submissionId}/${OWNER.jobId}/trace/../../../../elsewhere.zip`;
    expect(traversal.startsWith(`${OWNER.cohortId}/${OWNER.submissionId}/`)).toBe(true);
    expect(evidencePathBelongsTo(traversal, 'traces', OWNER, 'trace')).toBe(false);
  });

  it('refuses the right path in the wrong bucket', () => {
    expect(evidencePathBelongsTo(good.storagePath, 'submission-decks', OWNER, 'trace')).toBe(false);
    expect(evidencePathBelongsTo(good.storagePath, 'submission-screenshots', OWNER, 'trace')).toBe(false);
  });

  it('refuses a kind that does not match the path', () => {
    expect(evidencePathBelongsTo(good.storagePath, 'submission-screenshots', OWNER, 'screenshot')).toBe(false);
  });

  it('refuses a path with the wrong number of segments', () => {
    for (const wrong of [
      `${OWNER.cohortId}/${OWNER.submissionId}/${OWNER.jobId}/trace`,
      `${OWNER.cohortId}/${OWNER.submissionId}/${OWNER.jobId}/trace/sub/desktop.zip`,
      'desktop.zip',
      '',
    ]) {
      expect(evidencePathBelongsTo(wrong, 'traces', OWNER, 'trace'), wrong).toBe(false);
    }
  });

  it('refuses an unsanitised filename, even under the right prefix', () => {
    const sneaky = `${OWNER.cohortId}/${OWNER.submissionId}/${OWNER.jobId}/trace/desk top.zip`;
    expect(evidencePathBelongsTo(sneaky, 'traces', OWNER, 'trace')).toBe(false);
  });

  it('refuses an absolute path', () => {
    expect(evidencePathBelongsTo(`/${good.storagePath}`, 'traces', OWNER, 'trace')).toBe(false);
  });
});

describe('the limits', () => {
  it('expires an upload authorisation in minutes, not hours', () => {
    expect(EVIDENCE_UPLOAD_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(EVIDENCE_UPLOAD_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });

  it('allows a trace to be larger than a screenshot, because it is', () => {
    // Measured at 0.6–3.4 MB on real controlled runs.
    expect(EVIDENCE_MAX_BYTES.trace).toBeGreaterThan(EVIDENCE_MAX_BYTES.screenshot);
    expect(EVIDENCE_MAX_BYTES.trace).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it('recognises only the three evidence kinds', () => {
    expect(isEvidenceKind('trace')).toBe(true);
    expect(isEvidenceKind('screenshot')).toBe(true);
    expect(isEvidenceKind('artifact')).toBe(true);
    for (const no of ['deck', 'deck_pdf', 'submission-decks', '', '__proto__', 'constructor']) {
      expect(isEvidenceKind(no), no).toBe(false);
    }
  });
});
