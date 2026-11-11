CREATE TABLE IF NOT EXISTS "backfill_events" (
  "id"            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "occurred_at"   timestamptz NOT NULL DEFAULT now(),
  "enqueued_at"   timestamptz,
  "job"           text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_uri"  text NOT NULL,
  "resource_rkey" text NOT NULL,
  "outcome"       text NOT NULL,
  "reason"        text,
  "origin"        text,
  "attempts"      smallint NOT NULL,
  "max_attempts"  smallint NOT NULL,
  "duration_ms"   integer,
  "job_id"        bigint,
  "job_key"       text,
  "error"         text,
  "detail"        jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS "backfill_events_job_attempt_uidx"
  ON "backfill_events" ("job_id", "attempts") WHERE "job_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "backfill_events_occurred_idx"
  ON "backfill_events" ("occurred_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "backfill_events_job_occurred_idx"
  ON "backfill_events" ("job", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "backfill_events_type_occurred_idx"
  ON "backfill_events" ("resource_type", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "backfill_events_outcome_occurred_idx"
  ON "backfill_events" ("outcome", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "backfill_events_uri_occurred_idx"
  ON "backfill_events" ("resource_uri", "occurred_at" DESC);
