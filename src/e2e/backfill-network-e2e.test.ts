import { describe, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createTestDb } from '../test-utils/db.js';
import { runDumpImport } from '../import/dump-runner.js';
import { mapEditionToCandidates, olKeyOf } from '../import/mappers/openlibrary.js';

// Runs only when RUN_NETWORK_TESTS=1. Fetches a fresh slice of the real dump
// on demand (zcat | head -N | gzip) — exercises the exact real mapper/merge path.
describe.skipIf(!process.env.RUN_NETWORK_TESTS)('network E2E', () => {
  it(
    'imports a live OL editions slice',
    { timeout: 180_000 },
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'e2e-live-'));
      try {
        const { execSync } = await import('node:child_process');
        execSync(
          `curl -sL https://openlibrary.org/data/ol_dump_editions_latest.txt.gz | zcat | head -200 | gzip > ${join(tmp, 'ol-editions.txt.gz')}`,
          { stdio: 'pipe' },
        );
        const { db } = createTestDb();
        const summary = await runDumpImport({
          db, stateName: 'ol-editions', url: 'x', dumpPath: tmp,
          noDownload: true, keepDump: true, keyOf: olKeyOf,
          parse: (f) => mapEditionToCandidates(JSON.parse(f[4])),
        });
        console.log('live slice summary', summary);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
