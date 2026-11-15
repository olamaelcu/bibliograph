/**
 * Small support table shared with the edge: it throttles enqueueing the same
 * hydration job. The worker owns the DDL because the edge may run without a
 * worker (then it skips enqueueing entirely).
 */
export async function ensureSupportSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_enqueue_marks (
      key text PRIMARY KEY,
      enqueued_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS catalog_enqueue_marks_enqueued_at_idx ON catalog_enqueue_marks (enqueued_at)'
  );

  // Same shape as sql/0002-provider-usage.sql. The migration is the fresh-DB
  // path; this boot-time DDL upgrades an existing deployment with no manual
  // SQL step. Keep both definitions in sync.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_daily_usage (
      provider text NOT NULL,
      day date NOT NULL,
      calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
      PRIMARY KEY (provider, day)
    )
  `);
}

/**
 * Release graphile locks a previous process left behind.
 *
 * A graceful stop (SIGTERM) lets graphile finish in-flight work and release its
 * own locks, but a stop that outlives the abort window, a SIGKILL or a crash
 * leaves the job row and its queue row locked; graphile only reclaims them after
 * four hours, and a locked queue means that task cannot run at all — a stalled
 * `pds-publish` and a growing outbox.
 *
 * Only safe where exactly one worker owns the database: a second live worker's
 * locks would be stolen. The packaged single-instance unit therefore sets
 * `WORKER_CLEAR_STALE_LOCKS=1`; `index.js` calls this when it is set. Nothing
 * sensitive is cleared: an unlocked job simply becomes claimable again, and the
 * claim predicate still applies (attempts, backoff).
 *
 * Returns `{ jobs, queues }` — how many locks were cleared.
 */
export async function clearStaleGraphileLocks(pool, logger = console) {
  try {
    const jobs = await pool.query(
      `UPDATE graphile_worker._private_jobs
          SET locked_at = NULL, locked_by = NULL, run_at = greatest(run_at, now())
        WHERE locked_at IS NOT NULL`
    );
    const queues = await pool.query(
      `UPDATE graphile_worker._private_job_queues
          SET locked_at = NULL, locked_by = NULL
        WHERE locked_at IS NOT NULL`
    );
    return { jobs: jobs.rowCount ?? 0, queues: queues.rowCount ?? 0 };
  } catch (error) {
    // No graphile schema yet (a fresh database): nothing can be locked.
    if (error?.code === '42P01') return { jobs: 0, queues: 0 };
    logger?.warn?.(`worker: could not clear stale graphile locks — ${error.message}`);
    return { jobs: 0, queues: 0 };
  }
}
