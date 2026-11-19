import { defineConfig } from '@playwright/test';

/**
 * The end-to-end suite drives the librarian queue in a real browser against a
 * throwaway database and the fixture PDS/PLC, so it is deliberately serial: the
 * global setup owns one database, one worker and one edge process, and the two
 * scenarios share the contributor they claim.
 *
 * `mise run test-e2e` is the entry point: it supplies `.env` (PDS creds, the
 * Caddy CA) through mise, and `e2e/global-setup.ts` skips the suite with a
 * reason when that stack is not reachable.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  // A decision waits for graphile to pick up two jobs and for the record to
  // reach the fixture PDS; the default 30s is not enough for that path.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    // The fixture PDS answers over TLS with Caddy's internal CA; `mise run
    // hv-ca` can install it, but the suite must not depend on that.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure'
  }
});
