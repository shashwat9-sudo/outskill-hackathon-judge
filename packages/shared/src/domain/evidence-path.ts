/**
 * Where a piece of judging evidence is allowed to live.
 *
 * The worker holds no Storage credential. It asks the web app for permission to
 * write one object, and the web app decides the path — from the job id it was
 * given, never from anything the worker supplied. That is the whole security
 * property: a worker cannot name a destination, so it cannot write into another
 * team's prefix, and a compromised worker gains nothing but the ability to
 * overwrite its own screenshots.
 *
 * The path convention matches the one submissions already use, because the
 * storage RLS policy in migration 0003 reads the second segment and checks it:
 *
 *     <cohortId>/<submissionId>/<jobId>/<kind>/<filename>
 *
 * A path built any other way is refused here and would be refused again by
 * Postgres, which is the point of having both.
 */

/** The three private buckets evidence may occupy, and nothing else. */
export const EVIDENCE_BUCKETS = {
  screenshot: 'submission-screenshots',
  trace: 'traces',
  artifact: 'browser-evidence',
} as const;

export type EvidenceKind = keyof typeof EVIDENCE_BUCKETS;

export function isEvidenceKind(value: string): value is EvidenceKind {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_BUCKETS, value);
}

export interface EvidenceTarget {
  bucket: string;
  storagePath: string;
}

export interface EvidenceOwner {
  cohortId: string;
  submissionId: string;
  jobId: string;
}

/**
 * Strip a filename down to something that cannot escape its prefix.
 *
 * A worker-supplied filename is the one piece of caller input that reaches the
 * path at all, so it is reduced to a leaf name and a conservative character
 * set. `../` cannot survive this, and neither can an absolute path, a null
 * byte, or a name that is nothing but dots.
 */
export function sanitiseEvidenceFilename(filename: string, fallback = 'evidence'): string {
  const leaf = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = leaf
    .replace(/\0/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * The one path this job may write for this kind of evidence.
 *
 * Derived entirely from identifiers the server looked up. The only caller
 * contribution is the filename, and it has been reduced to a leaf.
 */
export function evidenceTarget(
  owner: EvidenceOwner,
  kind: EvidenceKind,
  filename: string,
): EvidenceTarget {
  for (const [name, value] of Object.entries(owner)) {
    if (!value || !/^[0-9a-fA-F-]{36}$/.test(value)) {
      throw new Error(`Refusing to build an evidence path: ${name} is not a uuid.`);
    }
  }

  return {
    bucket: EVIDENCE_BUCKETS[kind],
    storagePath: `${owner.cohortId}/${owner.submissionId}/${owner.jobId}/${kind}/${sanitiseEvidenceFilename(filename)}`,
  };
}

/**
 * Does this path belong to this job, in this bucket?
 *
 * Called again at confirmation time, on the path the worker echoes back. The
 * worker could return any string; only one is accepted, and it is the one the
 * server issued.
 *
 * Checked by reconstruction rather than by prefix matching. A prefix test would
 * accept `<cohort>/<submission>/<job>/trace/../../../elsewhere.zip`, which
 * starts with exactly the right characters and points somewhere else entirely.
 */
export function evidencePathBelongsTo(
  path: string,
  bucket: string,
  owner: EvidenceOwner,
  kind: EvidenceKind,
): boolean {
  if (path.includes('..') || path.includes('\0') || path.startsWith('/')) return false;
  if (bucket !== EVIDENCE_BUCKETS[kind]) return false;

  const segments = path.split('/');
  if (segments.length !== 5) return false;

  const [cohortId, submissionId, jobId, kindSegment, filename] = segments as [
    string, string, string, string, string,
  ];

  return (
    cohortId === owner.cohortId &&
    submissionId === owner.submissionId &&
    jobId === owner.jobId &&
    kindSegment === kind &&
    filename.length > 0 &&
    filename === sanitiseEvidenceFilename(filename)
  );
}

/**
 * How long an upload authorisation lives.
 *
 * Long enough for a trace of a few megabytes on a slow link, short enough that
 * a URL captured from a log is dead before anyone reads the log. Supabase
 * signed upload URLs are single-destination — this one cannot be pointed
 * anywhere else even while it is valid.
 */
export const EVIDENCE_UPLOAD_TTL_SECONDS = 300;

/** The largest evidence object we will accept, per kind. */
export const EVIDENCE_MAX_BYTES: Record<EvidenceKind, number> = {
  // A full-page PNG at 1440px.
  screenshot: 10 * 1024 * 1024,
  // Playwright traces carry screenshots per action and are the largest thing
  // this system stores. Measured at 0.6–3.4 MB on real runs; 50 gives headroom
  // without letting a runaway trace fill a bucket.
  trace: 50 * 1024 * 1024,
  artifact: 10 * 1024 * 1024,
};
