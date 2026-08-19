import type { SqlDatabase } from '../client';
import type { StorageAdapter } from '../storage';
import {
  EVIDENCE_BUCKETS,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_UPLOAD_TTL_SECONDS,
  evidencePathBelongsTo,
  evidenceTarget,
  type EvidenceKind,
} from '../../../domain/evidence-path';

/**
 * Durable browser evidence.
 *
 * The worker captures screenshots and traces on local disk and holds no Storage
 * credential, so it cannot put them anywhere durable by itself. It asks here for
 * permission to write one object, uploads to that one place, and asks here again
 * to confirm. Only the second call writes anything to the database.
 *
 * That ordering is the whole design. Before it, evidence lived on the worker's
 * disk and the database recorded the local path — which was harmless on a laptop
 * and untrue the moment the worker ran in a container, where the file vanishes
 * on the next deploy and the row keeps pointing at it. A row claiming evidence
 * that does not exist is the same defect as F-7 wearing a different hat, and the
 * fix is the same: ask the bucket, do not believe the client.
 */

export interface EvidenceTicket {
  ok: boolean;
  uploadUrl?: string;
  bucket?: string;
  storagePath?: string;
  maxBytes?: number;
  expiresInSeconds?: number;
  /** The content type the upload must declare. Storage refuses anything else. */
  contentType?: string;
  /**
   * Which attempt this authorisation belongs to.
   *
   * Echoed back at confirmation. If the job has been claimed again since — by
   * this worker or another — the attempt has moved on and this upload is stale.
   */
  attempt?: number;
  error?: string;
}

export interface EvidenceConfirmation {
  ok: boolean;
  bucket?: string;
  storagePath?: string;
  byteSize?: number;
  /** True when this exact object was already recorded — a safe repeat. */
  alreadyRecorded?: boolean;
  error?: string;
}

export interface EvidenceStore {
  createEvidenceUploadTicket(input: {
    jobId: string;
    kind: EvidenceKind;
    filename: string;
    workerId: string;
  }): Promise<EvidenceTicket>;

  confirmEvidenceUpload(input: {
    jobId: string;
    kind: EvidenceKind;
    bucket: string;
    storagePath: string;
    workerId: string;
    /** The attempt the ticket was issued under. */
    attempt: number;
    /** The browser run a trace belongs to. */
    runId?: string | null;
    /** The step a screenshot belongs to. */
    stepId?: string | null;
  }): Promise<EvidenceConfirmation>;

  /**
   * Where a recorded piece of evidence actually lives.
   *
   * Looked up from the run or step it is attached to, never accepted from a
   * caller. A route that took a bucket and a path as parameters would be
   * treating a storage path as an authorisation, and anyone who saw one in a
   * log could read anyone else's evidence.
   */
  getEvidenceObject(input: {
    kind: EvidenceKind;
    /** A browser run id for a trace, a step id for a screenshot. */
    id: string;
  }): Promise<EvidenceObject | null>;
}

export interface EvidenceObject {
  bucket: string;
  storagePath: string;
  /** For the audit entry, and for checking the path really is this job's. */
  submissionId: string;
  cohortId: string;
  jobId: string;
}

/**
 * The states in which a job may still be writing evidence.
 *
 * A completed job's evidence is finished; accepting more would let a stale
 * worker overwrite the record a human is reading. `manual_review` is included
 * because the browser stage writes evidence and then routes there.
 */
const WRITABLE_STAGES = [
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
  'manual_review',
];

interface JobRow {
  id: string;
  cohort_id: string;
  submission_id: string;
  stage: string;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
}

export function buildEvidenceStore(db: SqlDatabase, storage: StorageAdapter): EvidenceStore {
  /**
   * Who owns this job, and may it be written to right now?
   *
   * Every field the path is built from comes from this row. Nothing the caller
   * sent contributes to a destination.
   */
  async function authorise(
    jobId: string,
  ): Promise<{ ok: true; job: JobRow } | { ok: false; error: string }> {
    if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) {
      return { ok: false, error: 'Unknown job.' };
    }

    const { rows } = await db.query<JobRow>(
      `select j.id, j.cohort_id, j.submission_id, j.stage, j.claimed_by, j.lease_expires_at,
              j.attempt_count
         from assessment_jobs j
         join submissions s on s.id = j.submission_id and s.cohort_id = j.cohort_id
        where j.id = $1`,
      [jobId],
    );

    const job = rows[0];
    // The join is the cohort/submission relationship check: a job whose
    // submission belongs to a different cohort matches nothing and reads here
    // as an unknown job.
    if (!job) return { ok: false, error: 'Unknown job.' };

    if (!WRITABLE_STAGES.includes(job.stage)) {
      return { ok: false, error: `Job is ${job.stage}; evidence may no longer be written.` };
    }

    return { ok: true, job };
  }

  /** Is this worker holding a live lease on this job right now? */
  function holdsLiveLease(job: JobRow, workerId: string): boolean {
    if (job.claimed_by !== workerId) return false;
    return Boolean(job.lease_expires_at && new Date(job.lease_expires_at) > new Date());
  }

  return {
    async createEvidenceUploadTicket({ jobId, kind, filename, workerId }) {
      const auth = await authorise(jobId);
      if (!auth.ok) return { ok: false, error: auth.error };

      /*
       * A new authorisation requires a live lease this worker owns.
       *
       * Finishing an upload after a lease lapses is legitimate — the bytes were
       * captured while the worker held the job. Asking for permission to start
       * a *new* one is not: by then the job may belong to somebody else, and a
       * worker that has lost its lease has no business writing anything further.
       */
      if (!holdsLiveLease(auth.job, workerId)) {
        return {
          ok: false,
          error: 'This worker does not hold a live lease on that job.',
        };
      }

      const owner = {
        cohortId: auth.job.cohort_id,
        submissionId: auth.job.submission_id,
        jobId: auth.job.id,
      };

      let target;
      try {
        target = evidenceTarget(owner, kind, filename);
      } catch {
        return { ok: false, error: 'Could not derive an evidence path for this job.' };
      }

      try {
        const signed = await storage.createSignedUploadUrl(target.bucket, target.storagePath);
        return {
          ok: true,
          uploadUrl: signed.url,
          bucket: target.bucket,
          storagePath: target.storagePath,
          maxBytes: EVIDENCE_MAX_BYTES[kind],
          expiresInSeconds: EVIDENCE_UPLOAD_TTL_SECONDS,
          contentType: EVIDENCE_CONTENT_TYPES[kind],
          attempt: auth.job.attempt_count,
        };
      } catch {
        return { ok: false, error: 'Could not authorise an upload. Try again.' };
      }
    },

    async confirmEvidenceUpload({ jobId, kind, bucket, storagePath, workerId, attempt, runId, stepId }) {
      const auth = await authorise(jobId);
      if (!auth.ok) return { ok: false, error: auth.error };

      /*
       * The attempt this authorisation was issued under must still be current.
       *
       * A lease that merely expired is fine — the upload was authorised while
       * the worker held the job, and the bytes are its own. What is not fine is
       * a *newer* attempt having started: `attempt_count` increments on every
       * claim, so a higher count means another worker (or this one, retrying)
       * has since taken the job and is producing its own evidence. Letting the
       * older attempt confirm would overwrite the newer run's record with
       * observations of a different run.
       */
      if (auth.job.attempt_count !== attempt) {
        return {
          ok: false,
          error: `This upload belongs to attempt ${attempt}; the job is now on attempt ${auth.job.attempt_count}.`,
        };
      }

      /*
       * And nobody else may be holding the job right now.
       *
       * Redundant with the attempt check in every path we can construct — a
       * re-claim increments the count — but it costs one comparison and it does
       * not depend on `attempt_count` being incremented by whichever query
       * claims the job next. A live lease held by a different worker means this
       * confirmation is stale, whatever the counter says.
       */
      if (auth.job.claimed_by && auth.job.claimed_by !== workerId) {
        const heldByAnother =
          auth.job.lease_expires_at && new Date(auth.job.lease_expires_at) > new Date();
        if (heldByAnother) {
          return { ok: false, error: 'This job is now leased by another worker.' };
        }
      }

      const owner = {
        cohortId: auth.job.cohort_id,
        submissionId: auth.job.submission_id,
        jobId: auth.job.id,
      };

      /*
       * The path is reconstructed, not trusted.
       *
       * This is the only caller-supplied value that reaches a destination, and
       * a prefix check would accept `…/trace/../../../elsewhere.zip`. See
       * `evidence-path.ts` for why the check is a rebuild rather than a
       * `startsWith`.
       */
      if (!evidencePathBelongsTo(storagePath, bucket, owner, kind)) {
        return { ok: false, error: 'That evidence path does not belong to this job.' };
      }

      // What is actually in the bucket, according to the bucket.
      let stat: { byteSize: number; mimeType: string | null } | null;
      try {
        stat = await storage.statObject(bucket, storagePath);
      } catch {
        return { ok: false, error: 'Could not confirm the upload. Try again.' };
      }

      if (!stat) {
        // Never arrived, or was cut off before Storage kept it. No metadata is
        // written, and the worker keeps its local copy for a retry.
        return { ok: false, error: 'The upload did not finish. Nothing has been recorded.' };
      }
      if (stat.byteSize <= 0) {
        return { ok: false, error: 'The uploaded object is empty. Nothing has been recorded.' };
      }
      if (stat.byteSize > EVIDENCE_MAX_BYTES[kind]) {
        return { ok: false, error: 'The uploaded object is larger than this evidence kind allows.' };
      }

      /*
       * Recorded last, and idempotently.
       *
       * A retry re-uploads to the same derived path and lands here again. The
       * writes below set the column to the value it already holds, so a second
       * confirmation is a no-op rather than a duplicate.
       */
      let alreadyRecorded = false;

      if (kind === 'trace' && runId) {
        const { rows } = await db.query<{ trace_path: string | null }>(
          `select trace_path from browser_test_runs where id = $1 and job_id = $2`,
          [runId, jobId],
        );
        if (rows.length === 0) return { ok: false, error: 'That browser run does not belong to this job.' };
        alreadyRecorded = rows[0]!.trace_path === storagePath;
        await db.query(`update browser_test_runs set trace_path = $1 where id = $2 and job_id = $3`, [
          storagePath,
          runId,
          jobId,
        ]);
      } else if (kind === 'screenshot' && stepId) {
        // Scoped through the run to the job, so a step id from another job
        // updates nothing.
        const { rows } = await db.query<{ screenshot_path: string | null }>(
          `select s.screenshot_path
             from browser_test_steps s
             join browser_test_runs r on r.id = s.run_id
            where s.id = $1 and r.job_id = $2`,
          [stepId, jobId],
        );
        if (rows.length === 0) return { ok: false, error: 'That step does not belong to this job.' };
        alreadyRecorded = rows[0]!.screenshot_path === storagePath;
        await db.query(
          `update browser_test_steps s set screenshot_path = $1
             from browser_test_runs r
            where s.id = $2 and r.id = s.run_id and r.job_id = $3`,
          [storagePath, stepId, jobId],
        );
      }

      return { ok: true, bucket, storagePath, byteSize: stat.byteSize, alreadyRecorded };
    },

    async getEvidenceObject({ kind, id }) {
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;

      /*
       * The path comes from here, joined back to the job that owns it.
       *
       * Everything an admin route needs to serve a file — and to prove it is
       * serving the right one — is in this row. The caller supplies only which
       * run or step it wants to look at.
       */
      const sql =
        kind === 'trace'
          ? `select r.trace_path as path, j.id as job_id, j.submission_id, j.cohort_id
               from browser_test_runs r
               join assessment_jobs j on j.id = r.job_id
              where r.id = $1`
          : `select s.screenshot_path as path, j.id as job_id, j.submission_id, j.cohort_id
               from browser_test_steps s
               join browser_test_runs r on r.id = s.run_id
               join assessment_jobs j on j.id = r.job_id
              where s.id = $1`;

      const { rows } = await db.query<{
        path: string | null;
        job_id: string;
        submission_id: string;
        cohort_id: string;
      }>(sql, [id]);

      const row = rows[0];
      if (!row?.path) return null;

      const owner = {
        cohortId: row.cohort_id,
        submissionId: row.submission_id,
        jobId: row.job_id,
      };
      const bucket = EVIDENCE_BUCKETS[kind];

      // The same reconstruction the confirmation used. A stored path that no
      // longer reconstructs means the row was written by something other than
      // this code path, and it is not served.
      if (!evidencePathBelongsTo(row.path, bucket, owner, kind)) return null;

      return { bucket, storagePath: row.path, ...owner };
    },
  };
}
