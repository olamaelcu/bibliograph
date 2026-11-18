import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.js'],
    // One throwaway Postgres per run, schema applied from sql/*.sql: the suite
    // truncates the catalog, so it must never see the development database.
    globalSetup: ['./vitest.global-setup.js'],
    // The suite creates, truncates and shares its own tables, so every test
    // file gets its own process (`forks`, the isolation `node --test` gave it)
    // instead of sharing one worker. All of them point at that same container.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000
  }
});
