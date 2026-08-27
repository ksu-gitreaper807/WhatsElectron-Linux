import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The tests are plain unit tests (no display, no D-Bus, no Electron): they
    // must run in CI on a machine with none of the three.
    pool: 'forks',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/shared/**', 'src/main/**'],
      exclude: ['src/main/main.ts', 'src/**/index.ts', 'src/tools/**'],
      thresholds: { lines: 60, functions: 60, statements: 60 },
    },
  },
});
