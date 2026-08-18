import 'server-only';

import {
  MemoryDataStore,
  asDemoStore,
  createPostgresDataStore,
  loadEnv,
  storeCapabilities,
  supabaseSecretKey,
  type DataStore,
  type Env,
  type StoreCapabilities,
} from '@ohj/shared';

/**
 * Data-store singleton.
 *
 * Application code asks for a `DataStore` and never learns which driver it got
 * (ADR-003). In demo mode that is the deterministic memory driver; in production
 * it is the Postgres driver against Supabase.
 *
 * There is no fallback between them, in either direction. Silently serving
 * fixtures when the database is unreachable would let the platform look healthy
 * while accepting submissions into memory that vanish on the next restart —
 * far worse than refusing to start.
 *
 * The instance is cached on `globalThis` so Next's dev-mode module reloading
 * does not reset fixture state or churn database connections between requests.
 */

const STORE_KEY = Symbol.for('ohj.datastore');
const ENV_KEY = Symbol.for('ohj.env');
const PENDING_KEY = Symbol.for('ohj.datastore.pending');

type GlobalWithStore = typeof globalThis & {
  [STORE_KEY]?: DataStore;
  [ENV_KEY]?: Env;
  [PENDING_KEY]?: Promise<DataStore>;
};

const globalRef = globalThis as GlobalWithStore;

export function getEnvConfig(): Env {
  globalRef[ENV_KEY] ??= loadEnv();
  return globalRef[ENV_KEY];
}

export class ProductionConfigError extends Error {
  override readonly name = 'ProductionConfigError';
}

/**
 * The store, for production and demo alike.
 *
 * Async because the production driver imports `pg` and the Supabase client
 * dynamically. In demo mode it resolves immediately.
 */
export async function getStoreAsync(): Promise<DataStore> {
  if (globalRef[STORE_KEY]) return globalRef[STORE_KEY];

  const env = getEnvConfig();

  if (env.DEMO_MODE) {
    globalRef[STORE_KEY] = new MemoryDataStore();
    return globalRef[STORE_KEY];
  }

  // Concurrent requests during a cold start must share one connection attempt,
  // not open a pool each.
  globalRef[PENDING_KEY] ??= buildProductionStore(env).then((store) => {
    globalRef[STORE_KEY] = store;
    return store;
  });

  try {
    return await globalRef[PENDING_KEY];
  } catch (error) {
    // Clear the cached failure so the next request retries rather than being
    // stuck behind a transient startup problem forever.
    delete globalRef[PENDING_KEY];
    throw error;
  }
}

async function buildProductionStore(env: Env): Promise<DataStore> {
  const secretKey = supabaseSecretKey(env);

  // `loadEnv` already refuses to parse without these. Checked again here so the
  // failure names the specific missing value rather than a generic one, and so
  // this function is safe to call from a test with a hand-built env.
  const missing = [
    ['DATABASE_URL', env.DATABASE_URL],
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_SECRET_KEY', secretKey],
    ['ADMIN_SESSION_SECRET', env.ADMIN_SESSION_SECRET],
    ['CREDENTIAL_ENCRYPTION_KEY', env.CREDENTIAL_ENCRYPTION_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new ProductionConfigError(
      `Cannot start in production mode: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Set DEMO_MODE=1 to run locally against fixtures. The application will not fall back to in-memory data.',
    );
  }

  return createPostgresDataStore({
    databaseUrl: env.DATABASE_URL as string,
    supabaseUrl: env.SUPABASE_URL as string,
    supabaseSecretKey: secretKey as string,
    sessionSecret: env.ADMIN_SESSION_SECRET as string,
    credentialKey: env.CREDENTIAL_ENCRYPTION_KEY as string,
    credentialKeyVersion: env.CREDENTIAL_KEY_VERSION,
    maxConnections: env.DATABASE_POOL_MAX,
  });
}

/**
 * Synchronous accessor.
 *
 * Kept for call sites that cannot await. It throws in production until the
 * store has been built, which is why every route resolves it through
 * `getStoreAsync` first — see `apps/web/src/lib/store-init.ts`.
 */
export function getStore(): DataStore {
  const store = globalRef[STORE_KEY];
  if (store) return store;

  const env = getEnvConfig();
  if (env.DEMO_MODE) {
    globalRef[STORE_KEY] = new MemoryDataStore();
    return globalRef[STORE_KEY];
  }

  throw new ProductionConfigError(
    'The production data store has not been initialised for this request. ' +
      'Await getStoreAsync() before reading the store.',
  );
}

/** What this deployment can actually do. Assessment is Phase B. */
export function getCapabilities(): StoreCapabilities {
  return storeCapabilities(getStore());
}

/**
 * Demo-only accessor for fixture internals.
 *
 * Feature-detects rather than using `instanceof`: the store is cached on
 * `globalThis` and survives module reloading, so a class-identity check would
 * compare against a stale constructor and return null.
 */
export function getDemoStore() {
  // Null in production rather than throwing. Every caller is already behind an
  // `isDemo()` check, and a demo helper is not worth a 500 if one is ever
  // forgotten — the correct production behaviour is "there is no demo data".
  if (!getEnvConfig().DEMO_MODE) return null;
  return asDemoStore(getStore());
}

export function isDemo(): boolean {
  return getEnvConfig().DEMO_MODE;
}

/** Test helper — drops the cached store so the next call rebuilds it. */
export function resetStoreForTests(): void {
  delete globalRef[STORE_KEY];
  delete globalRef[ENV_KEY];
  delete globalRef[PENDING_KEY];
}
