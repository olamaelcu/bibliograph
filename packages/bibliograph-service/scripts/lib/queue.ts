import { sql } from 'drizzle-orm';
import { db } from '../../src/lib/server/db';

/** The `jobKey` every ISBN backfill is enqueued under. */
export const ISBN_BACKFILL_JOB_KEY_PREFIX = 'backfill-isbn:';

/**
 * URIs that already have a `backfill-edition-isbn` job in the queue.
 *
 * graphile-worker's `jobKey` already makes `addJob` idempotent while a job is
 * pending, but the scan still pays for the round trip. Filtering the batch here
 * keeps a bounded tick from spending its row budget on work the queue holds.
 * The key carries the uri, which is cheaper to read than the payload (stored in
 * `_private_jobs`). A fresh local database has no `graphile_worker` schema until
 * the worker first boots, hence the catch: an absent queue means nothing is
 * pending.
 */
export async function queuedIsbnBackfillUris(): Promise<Set<string>> {
  try {
    const result = await db.execute<{ key: string }>(sql`
      SELECT key
        FROM graphile_worker.jobs
       WHERE task_identifier = 'backfill-edition-isbn' AND key IS NOT NULL
    `);
    return new Set(
      result.rows.map((row) => row.key.slice(ISBN_BACKFILL_JOB_KEY_PREFIX.length)),
    );
  } catch {
    return new Set();
  }
}
