-- Reader directory read model (`net.olamaelcu.livtet.biblio.searchActors`).
--
-- `searchActors` filters on handle / display name and probes `records` for a
-- collection in the same WHERE, before ORDER BY / LIMIT / OFFSET. A view over
-- `records` cannot answer the first half: profiles are not ingested (TAP filters
-- to `net.olamaelcu.livtet.biblio.*`, and Livtet writes
-- `net.olamaelcu.livtet.actor.profile`), and no book record carries a handle.
-- Resolving identity per request would put one outbound round trip behind every
-- candidate, so the fields are denormalized into this table by
-- `scripts/backfill-actors.ts`.
--
-- The trigram GINs match the `ILIKE '%q%'` predicate in
-- `src/lib/server/actor-directory.ts`, the same shape 0005 gave
-- editions/works/contributors. `pg_trgm` itself is created by 0005.

CREATE TABLE IF NOT EXISTS "actors" (
  "did" text PRIMARY KEY NOT NULL,
  "handle" text,
  "display_name" text,
  "description" text,
  "avatar_cid" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actors_handle_trgm"
  ON "actors" USING gin ("handle" gin_trgm_ops);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actors_display_name_trgm"
  ON "actors" USING gin ("display_name" gin_trgm_ops);

--> statement-breakpoint
-- Seed the DIDs the mirror already holds, so the directory answers the
-- `hasRecords` half of a query as soon as the migration lands instead of
-- waiting for the first timer tick. `to_timestamp(0)` marks every seeded row
-- as never resolved, which is what makes the backfill pick it up, and the
-- script repeats this insert on every run for DIDs that arrive later.
INSERT INTO "actors" ("did", "updated_at")
SELECT DISTINCT "did", to_timestamp(0)
  FROM "records"
ON CONFLICT ("did") DO NOTHING;
