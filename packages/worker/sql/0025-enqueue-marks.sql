-- 0025-enqueue-marks.sql
--
-- Move `catalog_enqueue_marks` into the versioned schema.
--
-- The table throttles enqueueing the same hydration job and was created only by
-- `ensureSupportSchema` at worker boot (lib/setup.js), outside `sql/`. Two
-- consequences: the schema checks never saw it, and a database that has the
-- migrations but has not started a worker did not have the table at all — an
-- edge-only deployment or a fresh CI database differed from production.
--
-- From here the migration owns the DDL. lib/setup.js keeps its idempotent
-- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` boot-time DDL,
-- which is now a no-op on any database that ran this file; the definitions must
-- stay identical, and this file is the one to read first.

BEGIN;

CREATE TABLE IF NOT EXISTS catalog_enqueue_marks (
  key text PRIMARY KEY,
  enqueued_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_enqueue_marks_enqueued_at_idx
  ON catalog_enqueue_marks (enqueued_at);

COMMIT;
