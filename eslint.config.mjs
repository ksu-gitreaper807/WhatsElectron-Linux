// Flat config, ESLint 10. Rules chosen for a security-sensitive desktop app:
// correctness and untrusted-data handling first, style is Prettier's job.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'build/**', 'node_modules/**', 'coverage/**', '*.config.js', 'scripts/**/*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // One project for linting, covering src + test + configs. Using
        // `projectService` alone leaves the test files outside the default
        // project and every typed rule then errors with "not found by the
        // project service".
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The code base uses `unknown` everywhere untrusted data arrives; a bare
      // `any` in that neighbourhood is always a mistake.
      '@typescript-eslint/no-explicit-any': 'error',
      // Both are conventions in this code base, so they are enforced rather than
      // documented: untrusted data is narrowed with `unknown` + a guard, never
      // asserted through `any` or `!`.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Many implementations here are `async` only because the *interface* is
      // asynchronous (a backend may need the bus), while the method itself has
      // nothing to await. That is a deliberate contract, not a bug, so the rule
      // is off rather than suppressed 20 times.
      '@typescript-eslint/require-await': 'off',
      'require-await': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-param-reassign': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Preloads and the settings renderer have no Node: guard against importing it.
    files: ['src/preload/**/*.ts', 'src/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'renderers are sandboxed; use IPC' },
            { name: 'node:fs', message: 'renderers are sandboxed; use IPC' },
            { name: 'child_process', message: 'renderers must never spawn processes' },
            { name: 'node:child_process', message: 'renderers must never spawn processes' },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  prettierConfig,
);
