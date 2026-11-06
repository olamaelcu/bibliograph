#!/usr/bin/env tsx
// Re-enqueue ISBN lookups for editions an earlier run stamped `shadow`.
//
// Tier 2 of the ISBN backfill used to record its single surviving search
// candidate without writing it. Now it writes, so the rows stamped `shadow`
// need one more pass. The result check keeps this idempotent: a row that gains
// an ISBN has its result rewritten to `found`, and an ambiguous row stays
// `ambiguous`, so neither is asked about again.
//
// Run from the package root (an operator does):
//   node_modules/.bin/tsx scripts/enqueue-shadow-isbns.ts
//
// Locally:
//   pnpm tsx scripts/enqueue-shadow-isbns.ts --dry-run
//   pnpm tsx scripts/enqueue-shadow-isbns.ts --limit 50

import { sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { ProgressBar } from './lib/progress';
import { queuedIsbnBackfillUris } from './lib/queue';
import { editions } from '../src/lib/server/db/schema';

/**
 * Editions whose last ISBN lookup found a candidate but wrote nothing, and
 * which still have no ISBN.
 */
const SHADOW_PENDING = sql`
  EXISTS (
    SELECT 1 FROM edition_isbn_enrichment e
     WHERE e.uri = ${editions.uri} AND e.result = 'shadow'
  )
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(${editions.identifiers}) AS ident
     WHERE ident->>'type' = 'isbn'
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

  const queued = await queuedIsbnBackfillUris();
  const rows = (
    await db
      .select({ uri: editions.uri, rkey: editions.rkey })
      .from(editions)
      .where(SHADOW_PENDING)
      .orderBy(editions.indexedAt)
      .limit(limit + queued.size)
  )
    .filter((row) => !queued.has(row.uri))
    .slice(0, limit);

  console.log(`[enqueue-shadow-isbns] ${rows.length} shadow-stamped edition(s) still lack an ISBN`);

  if (dryRun) {
    console.log('[enqueue-shadow-isbns] dry run: nothing enqueued');
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[enqueue-shadow-isbns] DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  const bar = new ProgressBar('[enqueue-shadow-isbns]', rows.length);
  try {
    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-isbn',
        { uri: row.uri, rkey: row.rkey },
        { jobKey: `backfill-isbn:${row.uri}`, maxAttempts: 5 },
      );
      bar.advance();
    }
  } finally {
    await utils.release();
  }

  bar.finish();
  console.log(`[enqueue-shadow-isbns] enqueued ${bar.done} job(s)`);
}

run().catch((err) => {
  console.error('[enqueue-shadow-isbns] failed', err);
  process.exit(1);
});
