#!/usr/bin/env tsx
//
// Re-enqueue every edition whose `contributors` is empty so the GB/ISBNdb/
// Goodreads resolvers can repopulate them from upstream metadata. Idempotent — safe to
// re-run; the ingest handler overwrites on conflict.
//
//   pnpm backfill:edition-contributors       # enqueue all
//   pnpm backfill:edition-contributors -- --dry
//   pnpm backfill:edition-contributors -- --limit=500
//   pnpm backfill:edition-contributors -- --rkey=isbndb.9780441569595
//
// Requires DATABASE_URL.
//

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { fetchEditionForUri } from '../src/lib/server/shelving/edition-fetch';
import { enqueueIngest } from '../src/lib/server/jobs/enqueue';
import { createLogger } from '../src/lib/server/logger';
import { ProgressBar } from './lib/progress';

const PAGE_SIZE = 50;

const EMPTY_CONTRIBUTORS = sql`${editions.contributors} = '[]'::jsonb`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const hardLimit = limitArg ? Number(limitArg) : undefined;
  const rkeyArg = args.find((a) => a.startsWith('--rkey='))?.slice('--rkey='.length);

  const log = createLogger('worker');

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(editions)
    .where(rkeyArg === undefined ? EMPTY_CONTRIBUTORS : and(EMPTY_CONTRIBUTORS, eq(editions.rkey, rkeyArg))!);
  const outstanding = Number(counted?.count ?? 0);
  const bar = new ProgressBar(
    '[backfill-edition-contributors]',
    hardLimit === undefined ? outstanding : Math.min(outstanding, hardLimit),
  );

  let scanned = 0;
  let enqueued = 0;
  let skipped = 0;
  let failed = 0;
  let cursor: string | null = null;

  for (;;) {
    if (hardLimit !== undefined && scanned >= hardLimit) break;
    const pageSize = hardLimit !== undefined ? Math.min(PAGE_SIZE, hardLimit - scanned) : PAGE_SIZE;
    const filter: SQL | undefined =
      rkeyArg !== undefined
        ? and(EMPTY_CONTRIBUTORS, eq(editions.rkey, rkeyArg))!
        : cursor
          ? and(EMPTY_CONTRIBUTORS, sql`${editions.uri} > ${cursor}`)!
          : EMPTY_CONTRIBUTORS;

    const rows = await db
      .select({ uri: editions.uri })
      .from(editions)
      .where(filter as unknown as SQL)
      .orderBy(asc(editions.uri))
      .limit(pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      try {
        const item = await fetchEditionForUri(row.uri, log);
        if (!item) {
          skipped++;
        } else if (dry) {
          log.info({ stage: 'backfill-edition-contributors', uri: row.uri, contributors: item.contributors.length, dry: true }, 'dry run; would enqueue');
        } else {
          await enqueueIngest('edition', item);
          enqueued++;
        }
      } catch (err) {
        failed++;
        log.error({ stage: 'backfill-edition-contributors', uri: row.uri, err: String(err) }, 'enqueue failed');
      }
      bar.advance();
    }

    if (rkeyArg !== undefined) break;
    cursor = rows[rows.length - 1]?.uri ?? null;
  }

  bar.finish();
  const summary = { scanned, enqueued, skipped, failed };
  console.log(JSON.stringify({ stage: 'backfill-edition-contributors:summary', ...summary }));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('backfill-edition-contributors crashed:', err);
  process.exit(2);
});
