-- 0002-provider-usage.sql
--
-- Per-provider daily call accounting for metered upstream APIs.
--
-- ISBNdb bills per request, so the worker reserves one call per cache miss
-- before asking the network. The row is keyed by UTC day:
--
--   day = (now() AT TIME ZONE 'UTC')::date
--
-- The primary key makes the reservation atomic across worker processes and
-- restarts: the client runs
--
--   INSERT ... ON CONFLICT (provider, day)
--     DO UPDATE SET calls = calls + 1 WHERE calls < $limit
--   RETURNING calls
--
-- and treats "no row returned" as quota exhausted. Cache hits never reserve.
--
-- Idempotent like 0001: safe to re-run. The worker also creates the table at
-- boot (`ensureSupportSchema`), so an existing deployment upgrades without a
-- manual SQL step.

BEGIN;

CREATE TABLE IF NOT EXISTS provider_daily_usage (
  provider text NOT NULL,
  day date NOT NULL,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (provider, day)
);

COMMIT;
