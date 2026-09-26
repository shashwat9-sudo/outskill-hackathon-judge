/**
 * @ohj/shared — the contract layer.
 *
 * Everything that must agree between the web app and the worker lives here:
 * the rubric, the schemas, the status machines, the security primitives, the
 * test-action DSL, and the data-layer interfaces.
 */

export * from './rubric/index';

export * from './domain/status';
export * from './domain/artifact-state';
export * from './domain/deadline';
export * from './domain/disqualification';
export * from './domain/ranking';
export * from './domain/ids';
export * from './domain/submission-window';
export * from './domain/concurrency';
export * from './domain/cohort-exclusivity';
export * from './domain/cohort-deletion';
export * from './domain/missing-items';
export * from './domain/evidence-path';
export * from './domain/evidence-links';
export * from './domain/results-export';
export * from './domain/idea-catalogue';
export * from './config/cohort-ideas/index';
export * from './utils/learner-sheet';
export * from './intake/sheet-rows';
export * from './intake/sheet-sync';
// Server-only: reaches node:crypto. Never exported from the browser barrel.
export * from './intake/google-sheets';
export * from './domain/receipt-pdf';
export * from './domain/document-pdf';
export * from './content/submission-guide';
export * from './content/learner-guidance';
export * from './content/completed-example';

export * from './security/url';
export * from './security/crypto';
export * from './security/password';
export * from './security/access-code';
export * from './security/participant-session';

export * from './schemas/submission';

export * from './testing/dsl';

export * from './data/types';
export * from './data/store';
export { MemoryDataStore } from './data/memory/store';
export { createEmptyDatabase, seedDemoDatabase } from './data/memory/database';
export type { MemoryDatabase } from './data/memory/database';

export * from './fixtures/ideas';
export * from './fixtures/demo';

export * from './config/env';
export * from './config/brand';
export * from './utils/logger';
export * from './utils/csv';

// Production Postgres driver. Server-only: reaches `pg` and `@supabase/supabase-js`.
export * from './data/postgres/client';
export * from './data/postgres/storage';
export * from './data/postgres/store';
export * from './data/postgres/unavailable';
export * from './data/postgres/bootstrap';
