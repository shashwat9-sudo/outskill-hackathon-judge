import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint configuration.
 *
 * Deliberately focused. Formatting is not policed here — the rules that earn
 * their place are the ones that catch real defects, plus a small number that
 * protect the privacy and safety properties this system depends on.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      // Alternate build outputs (NEXT_DIST_DIR) — generated, never authored.
      '**/.next-*/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'reference-materials/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',

      // Safety rails specific to this system.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // React hooks rules for the web app.
  {
    files: ['apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Tests may be looser about assertions and non-null access.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts', 'e2e-staging/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // The staging suite measures a deployment and reports what it measured.
  // Printing the F-17 success rate and its latency spread is the deliverable,
  // not debugging left behind.
  {
    files: ['e2e-staging/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // The fixture app deliberately contains defects and inline scripts.
  {
    files: ['apps/worker/src/testing/fixture-app/**'],
    rules: { 'no-console': 'off' },
  },

  // Operator scripts are run by hand from a terminal; printing a readable
  // report IS their output. The rule stays on everywhere it protects a server
  // log from accidental noise.
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
