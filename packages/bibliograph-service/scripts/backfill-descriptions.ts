#!/usr/bin/env tsx
// Backfill editions that have no description and have never been checked.
//
// Mirrors `scripts/backfill-covers.ts`, `scripts/backfill-contributor-images.ts`
// and `scripts/backfill-edition-isbns.ts` in shape: this script only scans and
// enqueues — the worker does the fetching and stamps `description_checked_at`,
// which is what keeps a rerun from asking upstream about the same book twice.
//
// The packaged unit runs this as a daily oneshot, so the scan is a bounded
// batch (`--limit`) rather than a full sweep: each tick enqueues the first N
// actionable rows, and rows the worker deferred because an upstream was
// failing stay actionable, so the next tick picks them up again.
//
// "Actionable" excludes rows already checked (permanent miss) and rows that
// already have a job waiting, so a rerun enqueues only genuinely new work.
//
// Usage: `pnpm tsx scripts/backfill-descriptions.ts --limit 20000`
//        `pnpm tsx scripts/backfill-descriptions.ts --dry-run --limit 5`

import { and, asc, isNull, sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { ProgressBar } from './lib/progress';

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

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  // Known up front so the bar reports real progress rather than a spinner.
  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(editions)
    .where(ACTIONABLE);
  const actionable = Number(counted?.count ?? 0);

  const rows = await db
    .select({ uri: editions.uri })
    .from(editions)
    .where(ACTIONABLE)
    .orderBy(asc(editions.uri))
    .limit(limit);
  const bar = new ProgressBar('[backfill-descriptions]', Math.min(limit, actionable));
  console.log(`[backfill-descriptions] ${rows.length} of ${actionable} actionable edition(s)`);
  if (dryRun) {
    console.log('[backfill-descriptions] dry run: nothing enqueued');
    return;
  }

  const utils = await makeWorkerUtils({ connectionString: url });
  try {
    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-description',
        { uri: row.uri, source: 'scan' },
        {
          jobKey: `backfill-description:${row.uri}`,
          maxAttempts: 5,
        },
      );
      bar.advance();
    }
  } finally {
    await utils.release();
  }

  bar.finish();
  console.log(`[backfill-descriptions] enqueued ${bar.done} jobs`);
}

run().catch((err) => {
  console.error('[backfill-descriptions] failed:', err);
  process.exit(1);
});
