#!/usr/bin/env tsx
// Backfill every edition with `description IS NULL` through the
// description resolver. Mirrors `scripts/backfill-covers.ts` and
// `scripts/backfill-contributor-images.ts` in shape: enqueue via
// graphile-worker so the actual work runs in the worker process, not
// in this script. Use after deploying migration 0007 (or any other
// change) to populate `description` on existing editions.
//
// Usage: `pnpm tsx scripts/backfill-descriptions.ts`

import { isNull, sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';

const PAGE_SIZE = 200;

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  let totalEnqueued = 0;
  let emptyPasses = 0;
  while (emptyPasses < 2) {
    const rows = await db
      .select({ uri: editions.uri })
      .from(editions)
      .where(isNull(editions.description))
      .orderBy(sql`${editions.indexedAt} desc`)
      .limit(PAGE_SIZE);
    if (rows.length === 0) {
      emptyPasses++;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    emptyPasses = 0;
    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-description',
        { uri: row.uri },
        {
          jobKey: `backfill-description:${row.uri}`,
          maxAttempts: 5,
        },
      );
      totalEnqueued++;
    }
  }

  console.log(`[backfill-descriptions] enqueued ${totalEnqueued} jobs`);
}

run().catch((err) => {
  console.error('[backfill-descriptions] failed:', err);
  process.exit(1);
});