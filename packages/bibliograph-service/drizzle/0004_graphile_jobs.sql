-- drizzle/0004_graphile_jobs.sql
-- Graphile Worker schema + tables (job queue lives in Postgres, no extra service).
-- Two DLQ tables: ingest_dead_letter (search) + tap_dead_letter (TAP).
-- Graphile Worker will create graphile_worker schema + _jobs/_tasks/_scheduled_events
-- on first worker boot; we pre-create DLQ tables here so they're tracked by drizzle.

CREATE TABLE "ingest_dead_letter" (
  "id"            bigserial PRIMARY KEY,
  "uri"           text UNIQUE NOT NULL,
  "payload"       jsonb NOT NULL,
  "error_message" text NOT NULL,
  "attempts"      integer NOT NULL DEFAULT 0,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "ingest_dead_letter_created_at_idx" ON "ingest_dead_letter" ("created_at");

CREATE TABLE "tap_dead_letter" (
  "id"            bigserial PRIMARY KEY,
  "event_seq"     bigint,
  "repo_did"      text NOT NULL,
  "collection"    text NOT NULL,
  "rkey"          text NOT NULL,
  "payload"       jsonb NOT NULL,
  "error_message" text NOT NULL,
  "attempts"      integer NOT NULL DEFAULT 0,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "tap_dead_letter_created_at_idx" ON "tap_dead_letter" ("created_at");
CREATE INDEX "tap_dead_letter_did_idx" ON "tap_dead_letter" ("repo_did");

--> statement-breakpoint