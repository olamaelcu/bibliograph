#!/usr/bin/env tsx
//
// Backfill missing cover_url for editions.
// Enqueues `backfill-edition-cover` jobs for every edition where cover_url
// IS NULL and no job for it is already waiting. Safe to re-run: jobKey dedup
// keeps one queued job per edition and the handler checks already_has_cover.
//
//   pnpm backfill:covers           # enqueue all
//   pnpm backfill:covers -- --dry  # log without enqueue
//   pnpm backfill:covers -- --limit=500  # cap
//
// Requires DATABASE_URL.
//

import { and, asc, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { editions } from '../src/lib/server/db/schema';
import { createLogger } from '../src/lib/server/logger';
import { enqueueCoverBackfill } from '../src/lib/server/jobs/enqueue';
import { ProgressBar } from './lib/progress';

const PAGE_SIZE = 100;

/** How long a concluded lookup is trusted before the scan retries it. */
const RETRY_AFTER_DAYS = 30;

/**
 * Edition needs a cover and has nothing queued.
 *
 * The `NOT EXISTS` is what makes a rerun cheap: without it the scan re-arms
 * every pending job it can see. The stamp check is what keeps a scheduled run
 * finite: a row whose providers have no cover is not asked again for
 * `RETRY_AFTER_DAYS`, instead of being re-enqueued every four hours forever.
 */
const PENDING = and(
  isNull(editions.coverUrl),
  sql`(${editions.coverCheckedAt} IS NULL OR ${editions.coverCheckedAt} < now() - interval '${sql.raw(String(RETRY_AFTER_DAYS))} days')`,
  sql`NOT EXISTS (
    SELECT 1 FROM graphile_worker.jobs j
     WHERE j.key = 'backfill-cover:' || ${editions.uri}
  )`,
)!;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  // Accept both `--limit=N` and `--limit N`: the packaged unit passes the
  // space-separated form, and ignoring it turned a bounded tick into a full
  // backlog scan.
  let limitArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--limit=')) {
      limitArg = arg.slice('--limit='.length);
      break;
    }
    if (arg === '--limit') {
      limitArg = args[i + 1];
      break;
    }
  }
  const hardLimit = limitArg === undefined ? undefined : Number(limitArg);
  const log = createLogger('worker');

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(editions)
    .where(PENDING);
  const outstanding = Number(counted?.count ?? 0);
  const bar = new ProgressBar(
    '[backfill-covers]',
    hardLimit === undefined ? outstanding : Math.min(outstanding, hardLimit),
  );

  let total = 0;
  let enqueued = 0;
  let skipped = 0;
  let cursor: string | null = null;
  let failed = 0;

  for (;;) {
    if (hardLimit !== undefined && total >= hardLimit) break;
    const pageSize = hardLimit !== undefined ? Math.min(PAGE_SIZE, hardLimit - total) : PAGE_SIZE;
    const filter: SQL | undefined = cursor
      ? and(PENDING, sql`${editions.uri} > ${cursor}`)
      : PENDING;
    const rows: Array<{ uri: string; rkey: string }> = await db.select({ uri: editions.uri, rkey: editions.rkey }).from(editions)
      .where(filter as unknown as SQL)
      .orderBy(asc(editions.uri))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows as Array<{ uri: string; rkey: string }>) {
      cursor = row.uri;
      total++;
      try {
        if (dry) {
          log.info({ stage: 'backfill-covers', uri: row.uri, rkey: row.rkey }, 'dry-run: would enqueue');
          skipped++;
        } else {
          await enqueueCoverBackfill(row.uri, row.rkey);
          enqueued++;
        }
      } catch (err) {
        log.error({ stage: 'backfill-covers', err, uri: row.uri }, 'enqueue failed');
        failed++;
      }
      bar.advance();
      if (hardLimit !== undefined && total >= hardLimit) break;
    }
  }

  bar.finish();
  const summary = { stage: 'backfill-covers:summary', total, enqueued, skipped, failed, dry };
  console.log(JSON.stringify(summary));
  log.info(summary, 'backfill-covers done');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('backfill-covers crashed:', err);
  process.exit(2);
});
