/**
 * @ohj/shared — the contract layer.
 *
 * Everything that must agree between the web app and the worker lives here:
 * the rubric, the schemas, the status machines, the security primitives, the
 * test-action DSL, and the data-layer interfaces.
 */

export * from './rubric/index';

export * from './domain/status';
export * from './domain/deadline';
export * from './domain/disqualification';
export * from './domain/ranking';
export * from './domain/ids';

export * from './security/url';
export * from './security/crypto';
export * from './security/password';

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
