import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The client entry must come first — an exact-prefix alias for
      // '@ohj/shared' would otherwise swallow '@ohj/shared/client'.
      '@ohj/shared/client': resolve('./packages/shared/src/client.ts'),
      '@ohj/shared': resolve('./packages/shared/src/index.ts'),
      '@ohj/ai': resolve('./packages/ai/src/index.ts'),
      '@': resolve('./apps/web/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
    environmentMatchGlobs: [['apps/web/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./vitest.setup.ts'],

    /**
     * 5 seconds is too tight for this suite, and the failures it produces are
     * false ones.
     *
     * Argon2id and AES-GCM are deliberately slow, and several files run them in
     * parallel workers alongside PGlite's WASM Postgres. A test doing 360ms of
     * work has been observed timing out at 5s purely because every core was
     * busy hashing — measured, not assumed: the memory-store invite test takes
     * ~360ms alone and exceeded 5,000ms under a full run.
     *
     * 30s is still far below any genuine hang, and the tests that legitimately
     * take longer (booting PGlite) pass their own explicit timeout.
     */
    testTimeout: 30_000,
  },
});
