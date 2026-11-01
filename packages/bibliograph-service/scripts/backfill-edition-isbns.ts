#!/usr/bin/env tsx
// Enqueue an ISBN lookup for every catalog edition that has none.
//
// Mirrors `scripts/backfill-descriptions.ts`: this script only scans and
// enqueues, the worker does the fetching. Each row gains a row in
// `edition_isbn_enrichment` once the job has looked at it, so a rerun never
// re-asks upstream about a book that was already checked — and the scan does not
// page over rows the worker has not reached yet.
//
// Run from the package root (the packaged unit does):
//   node_modules/.bin/tsx scripts/backfill-edition-isbns.ts --limit 200
//
// Locally:
//   pnpm tsx scripts/backfill-edition-isbns.ts --dry-run
//   pnpm tsx scripts/backfill-edition-isbns.ts --limit 50

import { sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';

/**
 * Catalog editions that have no ISBN and have never been checked.
 *
 * The first half is what makes the timer idempotent; the second is the actual
 * defect being fixed.
 */
const PENDING = sql`
  NOT EXISTS (
    SELECT 1 FROM edition_isbn_enrichment e WHERE e.uri = ${editions.uri}
  )
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(${editions.identifiers}) AS ident
     WHERE ident->>'resource' IN ('isbn', 'isbn10', 'isbn13')
  )
`;

interface Options {
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  let limit = 5000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') continue;
    if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
      continue;
    }
    if (arg === '--limit') {
      limit = Number(argv[i + 1]);
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit must be a positive number');
  return { dryRun: argv.includes('--dry-run'), limit };
}

async function run(): Promise<void> {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  const rows = await db
    .select({ uri: editions.uri, rkey: editions.rkey })
    .from(editions)
    .where(PENDING)
    .orderBy(editions.indexedAt)
    .limit(limit);

  const byPrefix = new Map<string, number>();
  for (const row of rows) {
    const prefix = row.rkey.split('.')[0] ?? 'other';
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }

  console.log(`[backfill-edition-isbns] ${rows.length} edition(s) without an ISBN await enrichment`);
  for (const [prefix, count] of [...byPrefix].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${prefix.padEnd(8)} ${count}`);
  }

  if (dryRun) {
    console.log('[backfill-edition-isbns] dry run: nothing enqueued');
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[backfill-edition-isbns] DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  let enqueued = 0;
  try {
    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-isbn',
        { uri: row.uri, rkey: row.rkey },
        { jobKey: `backfill-isbn:${row.uri}`, maxAttempts: 5 },
      );
      enqueued++;
    }
  } finally {
    await utils.release();
  }

  console.log(`[backfill-edition-isbns] enqueued ${enqueued} job(s)`);
}

run().catch((err) => {
  console.error('[backfill-edition-isbns] failed:', err);
  process.exit(1);
});
