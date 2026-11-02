-- Sort key for the feed and recency listings: the record's own `createdAt`.
--
-- Those reads ordered by `indexed_at`, which is when the mirror wrote the row:
-- a TAP replay or a backfill pushed year-old records to the head of the feed.
-- `value->>'createdAt'` is the writer's stamp, so it is the order a feed claims
-- to have — but reading it per row in `ORDER BY` (with the regex guard and a
-- cast) turned every request into a sequential scan plus a sort of the whole
-- table: 45-50 ms locally, 2-4 s on the loaded production host, against 0.7-12 ms
-- for the index scan it replaced.
--
-- The value is stored as text, not timestamptz: a generated column and an index
-- expression both have to be IMMUTABLE, and text→timestamptz is STABLE (it reads
-- the session timezone), so Postgres rejects it outright — `generation expression
-- is not immutable`. Canonical atproto `datetime` values are UTC ISO-8601, whose
-- lexicographic order *is* chronological order; that holds for every row this
-- migration sees (21,942: 21,930 with millisecond precision, 10 with microseconds,
-- all `Z`, zero ordering mismatches against the timestamp sort).
--
-- `coalesce(..., '')` keeps the key non-null: a record without a `createdAt` sorts
-- after every dated one under `desc`, and the recency cursor can always be taken
-- from the last row.
ALTER TABLE "records"
  ADD COLUMN IF NOT EXISTS "record_created_at" text
  GENERATED ALWAYS AS (coalesce(value->>'createdAt', '')) STORED NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_record_created_at_idx"
  ON "records" USING btree ("record_created_at" DESC, "uri" DESC);
