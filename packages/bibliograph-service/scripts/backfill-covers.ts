#!/usr/bin/env tsx
//
// Backfill missing cover_image_url for editions.
// Enqueues `backfill-edition-cover` jobs for every edition where cover_image_url IS NULL.
// Idempotent — safe to re-run (handler checks already_has_cover). Uses jobKey dedup.
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

const PAGE_SIZE = 100;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const hardLimit = limitArg ? Number(limitArg) : undefined;
  const log = createLogger('worker');

  let total = 0;
  let enqueued = 0;
  let skipped = 0;
  let cursor: string | null = null;
  let failed = 0;

  for (;;) {
    if (hardLimit !== undefined && total >= hardLimit) break;
    const pageSize = hardLimit !== undefined ? Math.min(PAGE_SIZE, hardLimit - total) : PAGE_SIZE;
    const filter: SQL | undefined = cursor
      ? and(isNull(editions.coverImageUrl), sql`${editions.uri} > ${cursor}`)
      : isNull(editions.coverImageUrl);
    const rows: Array<{ uri: string; rkey: string }> = await db.select({ uri: editions.uri, rkey: editions.rkey }).from(editions)
      .where(filter as unknown as SQL)
      .orderBy(asc(editions.uri))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows as Array<{ uri: string; rkey: string }>) {
      cursor = row.uri;
      total++;
      if (dry) {
        log.info({ stage: 'backfill-covers', uri: row.uri, rkey: row.rkey }, 'dry-run: would enqueue');
        skipped++;
        continue;
      }
      try {
        await enqueueCoverBackfill(row.uri, row.rkey);
        enqueued++;
        if (enqueued % 50 === 0) log.info({ stage: 'backfill-covers', enqueued, total }, 'progress');
      } catch (err) {
        log.error({ stage: 'backfill-covers', err, uri: row.uri }, 'enqueue failed');
        failed++;
      }
      if (hardLimit !== undefined && total >= hardLimit) break;
    }
  }

  const summary = { stage: 'backfill-covers:summary', total, enqueued, skipped, failed, dry };
  console.log(JSON.stringify(summary));
  log.info(summary, 'backfill-covers done');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('backfill-covers crashed:', err);
  process.exit(2);
});
