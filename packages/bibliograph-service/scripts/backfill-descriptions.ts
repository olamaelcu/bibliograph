#!/usr/bin/env tsx
// Backfill editions that have no description and have never been checked.
//
// Mirrors `scripts/backfill-covers.ts`, `scripts/backfill-contributor-images.ts`
// and `scripts/backfill-edition-isbns.ts` in shape: this script only scans and
// enqueues — the worker does the fetching and stamps `description_checked_at`,
// which is what keeps a rerun from asking upstream about the same book twice.
//
// The scan pages by primary key with a keyset cursor, so every actionable row
// is enqueued exactly once per run and termination never depends on a worker
// draining rows while the scan is in flight. Rows that appear after the cursor
// has passed them are picked up by the next run.
//
// "Actionable" excludes rows already checked (permanent miss) and rows that
// already have a job waiting, so a rerun enqueues only genuinely new work.
//
// Usage: `pnpm tsx scripts/backfill-descriptions.ts`

import { and, asc, gt, isNull, sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { ProgressBar } from './lib/progress';

const PAGE_SIZE = 200;

/**
 * Rows worth a job: no cached description yet, and no earlier lookup that
 * already came up empty (`backfillDescriptionForEdition` stamps
 * `description_checked_at` on a miss, so re-enqueuing those would only repeat
 * the upstream calls).
 */
const ACTIONABLE = and(
  // Nothing cached yet.
  isNull(editions.description),
  // No earlier lookup that already came up empty:
  // `backfillDescriptionForEdition` stamps `description_checked_at` on a miss,
  // so these rows would only repeat the upstream calls.
  isNull(editions.descriptionCheckedAt),
  // Nothing already waiting in the queue. The scan is the only producer of
  // these jobs, so this is what makes a rerun cheap instead of re-arming every
  // pending job it can see.
  sql`NOT EXISTS (
    SELECT 1 FROM graphile_worker.jobs j
     WHERE j.key = 'backfill-description:' || ${editions.uri}
  )`,
)!;

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  // Known up front so the bar reports real progress rather than a spinner.
  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(editions)
    .where(ACTIONABLE);
  const bar = new ProgressBar('[backfill-descriptions]', Number(counted?.count ?? 0));

  let cursor: string | undefined;
  for (;;) {
    const filter = cursor === undefined ? ACTIONABLE : and(ACTIONABLE, gt(editions.uri, cursor))!;
    const rows = await db
      .select({ uri: editions.uri })
      .from(editions)
      .where(filter)
      .orderBy(asc(editions.uri))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-description',
        { uri: row.uri },
        {
          jobKey: `backfill-description:${row.uri}`,
          maxAttempts: 5,
        },
      );
      bar.advance();
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = last.uri;
  }

  bar.finish();
  console.log(`[backfill-descriptions] enqueued ${bar.done} jobs`);
}

run().catch((err) => {
  console.error('[backfill-descriptions] failed:', err);
  process.exit(1);
});
