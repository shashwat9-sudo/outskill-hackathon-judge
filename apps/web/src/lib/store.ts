import 'server-only';

import { MemoryDataStore, loadEnv, type DataStore, type Env } from '@ohj/shared';

/**
 * Data-store singleton.
 *
 * Application code asks for a `DataStore` and never learns which driver it got
 * (ADR-003). In demo mode that is the deterministic memory driver; from Phase 2
 * the postgres driver satisfies the same interfaces.
 *
 * The instance is cached on `globalThis` so Next's dev-mode module reloading
 * does not reset fixture state between requests — losing a draft on every hot
 * reload would make the portal impossible to demo.
 */

const STORE_KEY = Symbol.for('ohj.datastore');
const ENV_KEY = Symbol.for('ohj.env');

type GlobalWithStore = typeof globalThis & {
  [STORE_KEY]?: DataStore;
  [ENV_KEY]?: Env;
};

const globalRef = globalThis as GlobalWithStore;

export function getEnvConfig(): Env {
  globalRef[ENV_KEY] ??= loadEnv();
  return globalRef[ENV_KEY];
}

export function getStore(): DataStore {
  if (!globalRef[STORE_KEY]) {
    const env = getEnvConfig();
    if (env.DEMO_MODE) {
      globalRef[STORE_KEY] = new MemoryDataStore();
    } else {
      // Phase 2 wires the postgres driver here. Failing loudly is correct:
      // silently falling back to fixtures in production would be far worse.
      throw new Error(
        'DEMO_MODE is off but no database driver is configured. Set DEMO_MODE=1 for local use, or configure DATABASE_URL once the Supabase driver is enabled.',
      );
    }
  }
  return globalRef[STORE_KEY];
}

/** Demo-only: the memory driver, for helpers that need fixture internals. */
export function getMemoryStore(): MemoryDataStore | null {
  const store = getStore();
  return store instanceof MemoryDataStore ? store : null;
}

export function isDemo(): boolean {
  return getEnvConfig().DEMO_MODE;
}
