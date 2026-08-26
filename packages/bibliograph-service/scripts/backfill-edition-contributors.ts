#!/usr/bin/env tsx
//
// Re-enqueue every edition whose `contributors` is empty so the OL/GB/ISBNdb
// resolvers can repopulate them from upstream metadata. Idempotent — safe to
// re-run; the ingest handler overwrites on conflict.
//
//   pnpm backfill:edition-contributors       # enqueue all
//   pnpm backfill:edition-contributors -- --dry
//   pnpm backfill:edition-contributors -- --limit=500
//   pnpm backfill:edition-contributors -- --rkey=ol.OL24954708M
//
// Requires DATABASE_URL.
//

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { getEditionByRkey } from '../src/lib/server/api/open-library';
import { enqueueIngest } from '../src/lib/server/jobs/enqueue';
import { createLogger } from '../src/lib/server/logger';

const PAGE_SIZE = 50;

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
        ? eq(editions.rkey, rkeyArg)
        : cursor
          ? and(
              sql`${editions.contributors} = '[]'::jsonb`,
              sql`${editions.uri} > ${cursor}`,
            )
          : sql`${editions.contributors} = '[]'::jsonb`;

    const rows = await db
      .select({ uri: editions.uri, rkey: editions.rkey })
      .from(editions)
      .where(filter as unknown as SQL)
      .orderBy(asc(editions.uri))
      .limit(pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      try {
        const item = await getEditionByRkey(row.rkey, log as never);
        if (!item) {
          skipped++;
          continue;
        }
        if (dry) {
          log.info({ stage: 'backfill-edition-contributors', uri: row.uri, contributors: item.contributors.length, dry: true }, 'dry run; would enqueue');
          continue;
        }
        await enqueueIngest('edition', item);
        enqueued++;
        log.info({ stage: 'backfill-edition-contributors', uri: row.uri, rkey: row.rkey, contributors: item.contributors.length, payload: JSON.stringify(item.contributors) }, 'enqueued');
      } catch (err) {
        failed++;
        log.error({ stage: 'backfill-edition-contributors', uri: row.uri, err: String(err) }, 'enqueue failed');
      }
    }

    if (rkeyArg !== undefined) break;
    cursor = rows[rows.length - 1]?.uri ?? null;
  }

  const summary = { scanned, enqueued, skipped, failed };
  console.log(JSON.stringify({ stage: 'backfill-edition-contributors:summary', ...summary }));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('backfill-edition-contributors crashed:', err);
  process.exit(2);
});
