/**
 * The production data store.
 *
 * Satisfies the same `DataStore` interface as the memory driver, so application
 * code cannot tell which one it has (ADR-003).
 *
 * `capabilities` is what stops it pretending to be more complete than it is.
 * While assessment was unimplemented every method threw a named error rather
 * than returning `[]` or `null`, because an empty queue and a zero score render
 * as real answers. Both repositories are now implemented, so both capabilities
 * are declared — a claim that a test enforces rather than trusts.
 */

import type { DataStore } from '../store';
import type { SqlDatabase } from './client';
import { createPostgresDatabase } from './client';
import { buildAdminAuthStore, buildCohortStore } from './repositories/admin';
import { buildParticipantStore } from './repositories/participant';
import { buildSubmissionStore } from './repositories/submissions';
import { buildTeamStore } from './repositories/teams';
import { buildAuditStore, buildResourceStore, buildSettingsStore } from './repositories/support';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { createSupabaseStorage, type StorageAdapter } from './storage';
import type { StoreCapabilities } from './unavailable';

export interface PostgresStoreConfig {
  /** Transaction-pooler connection string for the serverless web tier. */
  databaseUrl: string;
  supabaseUrl: string;
  /** `sb_secret_...`, or the legacy service-role key. Server-side only. */
  supabaseSecretKey: string;
  /** Keys participant session hashes. */
  sessionSecret: string;
  credentialKey: string;
  credentialKeyVersion: number;
  maxConnections?: number;
}

/** A `DataStore` that also declares what it cannot do. */
export interface CapableDataStore extends DataStore {
  capabilities: StoreCapabilities;
}

/**
 * Build the production store.
 *
 * Async because both the Postgres pool and the Supabase client are imported
 * dynamically — neither should be pulled into a bundle that never uses them.
 */
export async function createPostgresDataStore(
  config: PostgresStoreConfig,
): Promise<CapableDataStore> {
  const db = await createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: config.maxConnections,
  });

  const storage = await createSupabaseStorage({
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseSecretKey,
  });

  return composePostgresDataStore(db, storage, config);
}

/**
 * Compose the repositories over a given client.
 *
 * Separate from `createPostgresDataStore` so tests can pass the in-process
 * engine and an in-memory storage adapter — the composition under test is then
 * the same object production uses.
 */
export function composePostgresDataStore(
  db: SqlDatabase,
  storage: StorageAdapter,
  config: Pick<PostgresStoreConfig, 'sessionSecret' | 'credentialKey' | 'credentialKeyVersion'>,
): CapableDataStore {
  return {
    driver: 'postgres',

    participant: buildParticipantStore({
      db,
      storage,
      sessionSecret: config.sessionSecret,
      credentialKey: config.credentialKey,
      credentialKeyVersion: config.credentialKeyVersion,
    }),
    adminAuth: buildAdminAuthStore(db),
    cohorts: buildCohortStore(db),
    teams: buildTeamStore(db),
    submissions: buildSubmissionStore({ db, credentialKey: config.credentialKey }),
    resources: buildResourceStore(db, storage),
    audit: buildAuditStore(db),
    settings: buildSettingsStore(db),

    assessment: buildAssessmentStore(db, storage),
    ranking: buildRankingStore(db),

    // Both repositories are implemented against this schema and exercised by
    // the PGlite suite. This flag governs whether the admin UI offers judging
    // at all, so it is not set from a method count — `assessment-coverage.test.ts`
    // asserts that every method on the interface is present and none of them is
    // the throwing stub.
    capabilities: { assessment: true, ranking: true },
  };
}

/**
 * Read a store's capabilities.
 *
 * The memory driver implements everything, so a store that does not declare
 * capabilities is fully capable. Callers use this rather than checking the
 * driver name, so a future partial driver is handled without changing them.
 */
export function storeCapabilities(store: DataStore): StoreCapabilities {
  const capable = store as Partial<CapableDataStore>;
  return capable.capabilities ?? { assessment: true, ranking: true };
}
