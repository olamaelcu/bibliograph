-- Collapse the work concept and add the Google Books response cache.
--
-- The work abstraction (works, work_identifiers, book_work_staging, and
-- books.work_pk) is gone: the net.olamaelcu.livtet.biblio.work lexicon no
-- longer exists, so the corresponding tables have no producer and no
-- consumer. AppView book reads are now backed by Google Books (see
-- src/google-books/), not the local catalog.
--
-- The OL dump import pipeline (book_contributor_staging, backfill_state,
-- backfill_reservation) is also gone: with the AppView reads served from
-- Google Books, the import pipeline has no read path left.
--
-- book_import_issues / work_import_issues are un-attributed views (see
-- memory #194) — we drop work_import_issues entirely and recreate
-- book_import_issues without the `work_pk` column. gb_cache backs the new
-- Google Books response cache (see src/google-books/cache.ts); entries are
-- pruned hourly by the `pnpm run gb:evict` script scheduled via
-- dokku-cron.

-- Drop the work-related views/tables (CASCADE so books.work_pk FK goes too).
DROP VIEW IF EXISTS "public"."work_import_issues" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "public"."works" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "public"."work_identifiers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "public"."book_work_staging" CASCADE;--> statement-breakpoint

-- Recreate book_import_issues without the work_pk column. Identical to the
-- migration-0001 view, minus b.work_pk.
DROP VIEW IF EXISTS "public"."book_import_issues";--> statement-breakpoint
CREATE VIEW "book_import_issues" AS ( SELECT b.pk,
    b.title,
    b.format_pk,
    b.publish_date,
    b.description,
    b.cover_url,
    b.cid,
    b.created_at,
    b.updated_at,
    b.release_status,
    b.released_at,
    ii.open_issues
   FROM books b
     JOIN ( SELECT import_issues.entity_pk,
            COALESCE(json_agg(json_build_object('pk', import_issues.pk, 'field', import_issues.field, 'incomingValue', import_issues.incoming_value, 'storedValue', import_issues.stored_value, 'source', import_issues.source, 'createdAt', import_issues.created_at) ORDER BY import_issues.created_at, import_issues.pk), '[]'::json) AS open_issues
            FROM import_issues
           WHERE import_issues.entity_type = 'book'::text AND import_issues.status = 'open'::text
           GROUP BY import_issues.entity_pk) ii ON ii.entity_pk = b.pk);--> statement-breakpoint

-- Drop OL-import staging and import-runner bookkeeping tables.
DROP TABLE IF EXISTS "public"."book_contributor_staging" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "public"."backfill_state" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "public"."backfill_reservation" CASCADE;--> statement-breakpoint

-- Update import_issues.entity_type CHECK to drop the 'work' variant.
ALTER TABLE "import_issues" DROP CONSTRAINT IF EXISTS "import_issues_entity_type_check";--> statement-breakpoint
ALTER TABLE "import_issues" ADD CONSTRAINT "import_issues_entity_type_check" CHECK ("entity_type" IN ('book', 'contributor', 'genre', 'contributorRole'));--> statement-breakpoint

-- Add the Google Books response cache table.
CREATE TABLE "gb_cache" (
	"request_hash" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" integer DEFAULT (extract(epoch from now())::int) NOT NULL
);--> statement-breakpoint
CREATE INDEX "gb_cache_expires_at_idx" ON "gb_cache" ("expires_at");--> statement-breakpoint
CREATE INDEX "gb_cache_endpoint_idx" ON "gb_cache" ("endpoint");
