import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.ts'],
    env: {
      DB_PATH: "data/test.sqlite"
    },
    globalSetup: ['./src/test-utils/global-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/test-utils/**', 'src/types.ts'],
    },
  },
});
