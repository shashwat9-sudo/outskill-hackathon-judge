/**
 * Browser-safe entry point.
 *
 * Client components import from `@ohj/shared/client`, never from the root
 * barrel. The root barrel reaches `node:crypto` and Argon2 through the security
 * modules, and those must never enter a browser bundle — both because they
 * cannot run there and, more importantly, because bundling credential handling
 * into client JavaScript would be a real disclosure risk.
 *
 * Everything exported here is pure TypeScript with no Node built-ins:
 * the rubric, the status machines, deadline formatting, the submission schemas,
 * URL validation, the test-action DSL, brand tokens, and type-only entities.
 *
 * If an import added here drags in `node:*`, the web build fails loudly rather
 * than silently shipping it — which is the behaviour we want.
 */

export * from './rubric/index';
export * from './domain/status';
export * from './domain/deadline';
export * from './domain/disqualification';
export * from './domain/ranking';
export * from './security/url';
export * from './schemas/submission';
export * from './testing/dsl';
export * from './config/brand';

// Type-only: erased at compile time, so no runtime import is emitted.
export type * from './data/types';
