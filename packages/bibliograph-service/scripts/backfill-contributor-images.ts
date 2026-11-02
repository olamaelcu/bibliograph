#!/usr/bin/env tsx
// Backfill every contributor that has no cached portrait and has never been
// checked through the resolver.
//
// Mirrors `scripts/backfill-descriptions.ts` in shape: this script only scans
// and enqueues — the worker does the fetching and stamps `image_checked_at`,
// which is what keeps a rerun from asking upstream about the same author twice.
//
// The scan pages by primary key with a keyset cursor, so every actionable row is
// enqueued exactly once per run and termination never depends on a worker
// draining rows while the scan is in flight.
//
// Usage: `pnpm tsx scripts/backfill-contributor-images.ts`

import { and, asc, gt, isNull, sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { contributors } from '../src/lib/server/db/schema';
import { ProgressBar } from './lib/progress';

const PAGE_SIZE = 200;

/**
 * Contributor needs a portrait, has never been checked, and has no job waiting.
 * `backfillContributorImageForUri` stamps `image_checked_at` on a miss, so the
 * second condition keeps a rerun from repeating those lookups.
 */
const ACTIONABLE = and(
  isNull(contributors.imageUrl),
  isNull(contributors.imageCheckedAt),
  sql`NOT EXISTS (
    SELECT 1 FROM graphile_worker.jobs j
     WHERE j.key = 'backfill-contributor-image:' || ${contributors.uri}
  )`,
)!;

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contributors)
    .where(ACTIONABLE);
  const bar = new ProgressBar('[backfill-contributor-images]', Number(counted?.count ?? 0));

  let cursor: string | undefined;
  for (;;) {
    const filter = cursor === undefined ? ACTIONABLE : and(ACTIONABLE, gt(contributors.uri, cursor))!;
    const rows = await db
      .select({ uri: contributors.uri })
      .from(contributors)
      .where(filter)
      .orderBy(asc(contributors.uri))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      await utils.addJob('backfill-contributor-image', { uri: row.uri }, {
        jobKey: `backfill-contributor-image:${row.uri}`,
        maxAttempts: 5,
      });
      bar.advance();
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = last.uri;
  }

  bar.finish();
  console.log(`[backfill-contributor-images] enqueued ${bar.done} jobs`);
}

run().catch((err) => {
  console.error('[backfill-contributor-images] failed:', err);
  process.exit(1);
});
