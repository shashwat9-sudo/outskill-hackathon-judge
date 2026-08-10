/**
 * @ohj/shared — the contract layer.
 *
 * Everything that must agree between the web app and the worker lives here:
 * the rubric, the schemas, the status machines, the security primitives, the
 * test-action DSL, and the data-layer interfaces.
 */

export * from './rubric/index.js';

export * from './domain/status.js';
export * from './domain/deadline.js';
export * from './domain/disqualification.js';
export * from './domain/ranking.js';
export * from './domain/ids.js';

export * from './security/url.js';
export * from './security/crypto.js';
export * from './security/password.js';

export * from './schemas/submission.js';

export * from './testing/dsl.js';

export * from './data/types.js';
export * from './data/store.js';
export { MemoryDataStore } from './data/memory/store.js';
export { createEmptyDatabase, seedDemoDatabase } from './data/memory/database.js';
export type { MemoryDatabase } from './data/memory/database.js';

export * from './fixtures/ideas.js';
export * from './fixtures/demo.js';

export * from './config/env.js';
export * from './config/brand.js';
export * from './utils/logger.js';
export * from './utils/csv.js';
