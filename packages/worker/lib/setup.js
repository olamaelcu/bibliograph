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
