import { defineConfig } from 'vitest/config';

// The tests import only modules that avoid the SvelteKit virtual modules, so the
// SvelteKit plugin is deliberately not loaded here.
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    // One throwaway Postgres per run: the DB-backed suites create and truncate
    // their own schemas, so they must never see the development database.
    globalSetup: ['./vitest.global-setup.ts'],
    // Each test file keeps its own process (`forks`, the isolation
    // `node --test` gave it) and gets the same container's `DATABASE_URL`.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000
  }
});
