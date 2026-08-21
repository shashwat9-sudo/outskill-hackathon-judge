/**
 * Audit, settings and resources.
 *
 * Small, but the audit log is the one that matters most: a shared admin account
 * can only be held accountable through its trail (threat model T6). `0001` puts
 * a trigger on `audit_logs` that rejects UPDATE and DELETE, so this repository
 * appends and reads, and there is deliberately no method that could do anything
 * else.
 */

import type { AuditLog, ResourceDocument, SystemSetting } from '../../types';
import type {
  AuditStore,
  ResourceStore,
  SettingsStore,
  WorkerStatus,
  WorkerStatusStore,
} from '../../store';
import type { SqlClient, SqlDatabase } from '../client';
import { RowNotFoundError } from '../client';
import { ARTIFACT_NUMERIC_COLUMNS, json, mapRow, mapRowWithNumbers, mapRowsWithNumbers, parseJson } from '../rows';
import type { StorageAdapter } from '../storage';

export function buildAuditStore(db: SqlDatabase): AuditStore {
  return {
    async record(entry) {
      await db.query(
        `insert into audit_logs
           (actor_type, actor_ref, action, entity_type, entity_id, cohort_id,
            before, after, ip_hash, user_agent_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.actorType,
          entry.actorRef,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.cohortId,
          entry.before === null ? null : json(entry.before),
          entry.after === null ? null : json(entry.after),
          entry.ipHash,
          entry.userAgentHash,
        ],
      );
    },

    async list(filter) {
      // Built as a fixed statement with optional predicates rather than string
      // concatenation of values: every filter is still a bound parameter.
      const { rows } = await db.query(
        `select * from audit_logs
          where ($1::text is null or entity_type = $1)
            and ($2::uuid is null or entity_id = $2)
            and ($3::uuid is null or cohort_id = $3)
          order by created_at desc
          limit $4`,
        [
          filter.entityType ?? null,
          filter.entityId ?? null,
          filter.cohortId ?? null,
          Math.min(filter.limit ?? 100, 1000),
        ],
      );
      return rows.map((row) => {
        const entry = mapRow<AuditLog>(row);
        return {
          ...entry,
          before: parseJson<Record<string, unknown> | null>(entry.before, null),
          after: parseJson<Record<string, unknown> | null>(entry.after, null),
        };
      });
    },
  };
}

/**
 * What each judging worker reports about itself.
 *
 * The admin judging page used to describe the AI provider from the *web*
 * tier's environment, which is not where judging happens — the web application
 * never constructs an AI client. On a production deployment with no AI key of
 * its own, the only states it could report were the two that say judging is not
 * real, so a cohort being judged against real Gemini was captioned "Demo
 * fixtures — no AI provider".
 *
 * The worker knows these things as facts. It writes them here, and the page
 * reads what the worker said rather than inferring it from an unrelated
 * environment.
 */
export function buildWorkerStatusStore(db: SqlDatabase): WorkerStatusStore {
  return {
    async report(status) {
      await db.query(
        `insert into worker_status
           (worker_id, ai_provider, ai_model, evaluation_mode, demo_mode,
            concurrency, driver, started_at, last_seen_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
         on conflict (worker_id) do update
            set ai_provider = excluded.ai_provider,
                ai_model = excluded.ai_model,
                evaluation_mode = excluded.evaluation_mode,
                demo_mode = excluded.demo_mode,
                concurrency = excluded.concurrency,
                driver = excluded.driver,
                -- A restart is a new process, and the operator wants to see it.
                started_at = excluded.started_at,
                last_seen_at = now(),
                updated_at = now()`,
        [
          status.workerId,
          status.aiProvider,
          status.aiModel,
          status.evaluationMode,
          status.demoMode,
          status.concurrency,
          status.driver,
          status.startedAt,
        ],
      );
    },

    async list() {
      const { rows } = await db.query('select * from worker_status order by last_seen_at desc');
      return rows.map((row) => {
        const status = mapRow<WorkerStatus>(row);
        return { ...status, concurrency: Number(status.concurrency) };
      });
    },
  };
}

export function buildSettingsStore(db: SqlDatabase): SettingsStore {
  return {
    async getAll() {
      const { rows } = await db.query('select * from system_settings order by key');
      return rows.map((row) => {
        const setting = mapRow<SystemSetting>(row);
        return { ...setting, value: parseJson<unknown>(setting.value, null) };
      });
    },

    async get<T>(key: string) {
      const { rows } = await db.query('select value from system_settings where key = $1', [key]);
      if (rows.length === 0) return null;
      return parseJson<T | null>((rows[0] as { value: unknown }).value, null);
    },

    async set(key, value, actor) {
      // Upsert: a setting that has never been written and one being changed are
      // the same operation to every caller.
      await db.query(
        `insert into system_settings (key, value, description, updated_by, updated_at)
         values ($1, $2, '', $3, now())
         on conflict (key) do update
           set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, json(value), actor],
      );
    },
  };
}

/**
 * Resources.
 *
 * `getSignedUrl` is the only read path for a stored file. Every bucket is
 * private, so there is no permanent URL to hand out even by mistake.
 */
export function buildResourceStore(db: SqlDatabase, storage: StorageAdapter): ResourceStore {
  return {
    async listResources(cohortId) {
      // Cohort-specific resources plus the global ones (cohort_id is null).
      const { rows } = await db.query(
        `select * from resource_documents
          where $1::uuid is null or cohort_id = $1 or cohort_id is null
          order by display_order, title`,
        [cohortId],
      );
      return mapRowsWithNumbers<ResourceDocument>(rows, ARTIFACT_NUMERIC_COLUMNS);
    },

    async createResource(input) {
      const { rows } = await db.query(
        `insert into resource_documents
           (cohort_id, kind, title, description, storage_bucket, storage_path,
            mime_type, byte_size, is_participant_visible, display_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *`,
        [
          input.cohortId,
          input.kind,
          input.title,
          input.description,
          input.storageBucket,
          input.storagePath,
          input.mimeType,
          input.byteSize,
          input.isParticipantVisible,
          input.displayOrder,
        ],
      );
      return mapRowWithNumbers<ResourceDocument>(rows[0] as Record<string, unknown>, ARTIFACT_NUMERIC_COLUMNS);
    },

    async deleteResource(id) {
      // Removes the record and the object. Order matters: if the object delete
      // fails, the record survives and the file is still reachable through the
      // application — which is recoverable. The reverse leaves a dangling row
      // pointing at nothing.
      const { rows } = await db.query(
        'select storage_bucket, storage_path from resource_documents where id = $1',
        [id],
      );
      if (rows.length === 0) throw new RowNotFoundError('Resource', id);

      const row = rows[0] as { storage_bucket: string; storage_path: string };
      await storage.remove(row.storage_bucket, [row.storage_path]);
      await db.query('delete from resource_documents where id = $1', [id]);
    },

    getSignedUrl(bucket, path, expiresInSeconds = 300) {
      return storage.createSignedDownloadUrl(bucket, path, expiresInSeconds);
    },
  };
}

/** Shared by repositories that need a client that may or may not be a transaction. */
export type Executor = SqlClient;
