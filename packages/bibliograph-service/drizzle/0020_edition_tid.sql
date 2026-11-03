-- Canonical book identity: `editions.tid` + the alias table that keeps retired
-- uris resolving.
--
-- Edition uris are provider namespaces (`ol.*`, `gb.*`, `bh.*`, `isbndb.*`), so
-- one book can exist as several rows — a Google Books mirror and the Bookhive
-- catalog record for the same volume, or two provider ids for one printing. A
-- librarian merge deletes the losers, which used to leave every shelving row,
-- review and client holding a dead uri *and* let the next ingest recreate the
-- duplicate as a brand-new row.
--
-- `tid` is the identifier that says "these uris describe one book". It is an
-- ATProto TID — 13 chars of lowercase base32 (`234567abcdefghij`
-- `klmnopqrstuvwxyz`, sortable), value = (microseconds << 10) | clock id — which
-- is the record-identifier shape the protocol already defines. A per-book
-- sequence for the low 10 bits plus the wall clock for the rest keeps values
-- unique and `tid` ordered like insert order.
--
-- `edition_aliases` records the losers of a merge against the winner's tid, so
-- `edition-lookup.ts` can answer any of a book's uris with the surviving record.
CREATE SEQUENCE IF NOT EXISTS "editions_tid_seq";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION editions_tid_encode(v bigint) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT string_agg(
           substr('234567abcdefghijklmnopqrstuvwxyz', (((v >> (5 * i)) & 31) + 1)::int, 1),
           '' ORDER BY i DESC
         )
  FROM generate_series(0, 12) AS i;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION editions_next_tid() RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT editions_tid_encode(
           ((extract(epoch FROM clock_timestamp()) * 1000000)::bigint << 10)
           | (nextval('editions_tid_seq') & 1023)
         );
$$;
--> statement-breakpoint
-- Backfill in (indexed_at, uri) order and step the clock per row, so existing
-- catalog rows come out with distinct, monotonically increasing tids — a fixed
-- base with only 1024 clock ids would collide every 1024 rows.
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "tid" text;
--> statement-breakpoint
UPDATE "editions" AS e
SET "tid" = editions_tid_encode(((b.base + s.rn) << 10) | (s.rn & 1023))
FROM (SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS base) b,
     (SELECT "uri", row_number() OVER (ORDER BY "indexed_at", "uri") - 1 AS rn FROM "editions") s
WHERE e."uri" = s."uri" AND e."tid" IS NULL;
--> statement-breakpoint
ALTER TABLE "editions" ALTER COLUMN "tid" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_tid_unique" UNIQUE ("tid");
--> statement-breakpoint
ALTER TABLE "editions" ALTER COLUMN "tid" SET DEFAULT editions_next_tid();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_aliases" (
  "uri" text PRIMARY KEY NOT NULL,
  "tid" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edition_aliases_tid_editions_tid_fk" FOREIGN KEY ("tid")
    REFERENCES "editions" ("tid") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_aliases_tid_idx" ON "edition_aliases" USING btree ("tid");
