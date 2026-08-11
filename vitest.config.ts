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
  },
});
