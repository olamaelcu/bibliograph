#!/usr/bin/env tsx
// Backfill every contributor with `imageCheckedAt IS NULL` through the
// resolver. Mirrors `scripts/backfill-covers.ts` in shape: enqueue via
// graphile-worker so the actual work runs in the worker process, not
// in this script. Use after deploying the 0007 migration to populate
// the image_url column on existing contributors.
//
// Usage: `pnpm tsx scripts/backfill-contributor-images.ts`

import { makeWorkerUtils } from 'graphile-worker';
import { findUncheckedContributorUris } from '../src/lib/server/jobs/contributor-image-backfill';

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  let totalEnqueued = 0;
  // `findUncheckedContributorUris` does NOT include an offset, so each pass
  // re-reads the same `LIMIT 200` rows. The loop relies on the worker
  // setting `imageCheckedAt` after each job so the next pass sees a fresh
  // batch. Two consecutive empty pages means we're done.
  let emptyPasses = 0;
  while (emptyPasses < 2) {
    const uris = await findUncheckedContributorUris(undefined, 200);
    if (uris.length === 0) {
      emptyPasses++;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    emptyPasses = 0;
    for (const uri of uris) {
      await utils.addJob('backfill-contributor-image', { uri }, {
        jobKey: `backfill-contributor-image:${uri}`,
        maxAttempts: 5,
      });
      totalEnqueued++;
    }
  }

  console.log(`[backfill-contributor-images] enqueued ${totalEnqueued} jobs`);
}

run().catch((err) => {
  console.error('[backfill-contributor-images] failed:', err);
  process.exit(1);
});