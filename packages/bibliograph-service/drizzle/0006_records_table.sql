-- drizzle/0006_records_table.sql
-- Create the generic `records` table that tap-consumer.ts and the new job
-- handlers import from `db/schema.ts`. The DB has a sibling `repo_records`
-- table from an earlier migration, but the drizzle type defs and the existing
-- tap-consumer code (in src/lib/server/tap-consumer.ts) reference `records`,
-- so this aligns the DB with the schema.

CREATE TABLE "records" (
  "uri" text PRIMARY KEY,
  "cid" text NOT NULL,
  "did" text NOT NULL,
  "rkey" text NOT NULL,
  "collection" text NOT NULL,
  "value" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "indexed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "records_collection_idx" ON "records" ("collection");
CREATE INDEX "records_indexed_at_idx" ON "records" ("indexed_at");

--> statement-breakpoint