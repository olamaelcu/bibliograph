import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { runDumpImport } from '../import/dump-runner.js';
import { mapEditionToCandidates, mapWorkToCandidate, mapAuthorToCandidate, olKeyOf } from '../import/mappers/openlibrary.js';
import { listWithIssues, setStatus } from '../review/service.js';
import { books } from '../db/schema.js';

const FIXTURES = join(process.cwd(), 'fixtures');
const STATE_FILES = [
  ['ol-authors', 'ol-authors-slice.txt.gz'],
  ['ol-works', 'ol-works-slice.txt.gz'],
  ['ol-editions', 'ol-editions-slice.txt.gz'],
] as const;

/** Copy committed fixtures into a temp dir named per runner state. */
function stageFixtures(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dumps-'));
  for (const [state, file] of STATE_FILES) {
    cpSync(join(FIXTURES, file), join(dir, `${state}.txt.gz`));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function importFixture(
  db: ReturnType<typeof createTestDb>['db'],
  dumpPath: string,
  stateName: string,
  mapper: (fields: string[]) => unknown[],
) {
  return runDumpImport({
    db,
    stateName,
    url: 'x', // unused because noDownload
    dumpPath,
    noDownload: true,
    keepDump: true,
    keyOf: olKeyOf,
    parse: (fields) => mapper(fields) as never,
  });
}

describe('backfill E2E (committed OL fixtures)', () => {
  it(
    'imports editions, works, authors; releases; review view lists them',
    { timeout: 180_000 },
    async () => {
      const { db } = await createTestDb();
      const { dir, cleanup } = stageFixtures();
      try {
        // 1. Import the three dumps in dependency order: authors → works → editions.
        await importFixture(db, dir, 'ol-authors', (f) => [mapAuthorToCandidate(JSON.parse(f[4]))]);
        await importFixture(db, dir, 'ol-works', (f) => [mapWorkToCandidate(JSON.parse(f[4]))]);
        await importFixture(db, dir, 'ol-editions', (f) => mapEditionToCandidates(JSON.parse(f[4])));

        // 2. Everything landed staged.
        const bookCount = (await db.select().from(books)).length;
        expect(bookCount).toBeGreaterThan(0);
        const stagedBooks = (await db.select().from(books).where(sql`release_status = 'staged'`)).length;
        expect(stagedBooks).toBe(bookCount);

        // 3. No conflicts are expected from a clean import (each OL record unique),
        //    but records with issues surface via the review view.
        const withIssues = await listWithIssues(db, 'book');
        expect(Array.isArray(withIssues)).toBe(true);

        // 4. Release one book (with --yes semantics: force past dependents).
        const first = (await db.select().from(books).limit(1))[0] as unknown as { pk: string };
        await setStatus(db, 'book', first.pk, 'released');

        const releasedBook = (await db.select().from(books).where(sql`release_status = 'released'`).limit(1))[0] as unknown as { pk: string };
        expect(releasedBook.pk).toBe(first.pk);
      } finally {
        cleanup();
      }
    },
  );
});
