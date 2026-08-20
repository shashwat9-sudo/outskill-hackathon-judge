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
export * from './domain/artifact-state';
export * from './domain/deadline';
export * from './domain/disqualification';
export * from './domain/ranking';
export * from './domain/submission-window';
export * from './domain/concurrency';
export * from './domain/cohort-exclusivity';
export * from './domain/cohort-deletion';
export * from './domain/missing-items';
export * from './domain/evidence-path';
export * from './utils/learner-sheet';
export * from './intake/sheet-rows';
// Guide content is plain data; only its PDF renderer touches Buffer.
export type * from './content/submission-guide';
// Learner guidance is pure data — the same sentences the form, the example and
// the guide all read, so none of them can drift from the others.
export * from './content/learner-guidance';
export * from './content/completed-example';
export * from './security/url';
export * from './schemas/submission';
export * from './testing/dsl';
export * from './config/brand';

// Constants only — the generation and verification functions live in
// `access-code.ts`, which reaches `node:crypto` and Argon2 and must not be
// bundled for the browser.
export {
  ACCESS_CODE_LENGTH,
  ACCESS_CODE_GROUP_SIZE,
  GENERIC_VERIFICATION_ERROR,
} from './security/access-code-constants';

// Type-only: erased at compile time, so no runtime import is emitted.
export type * from './data/types';
