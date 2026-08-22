-- Drop the staged-release lifecycle and its supporting tables.
--
-- The CLI backfill pipeline (OpenLibrary dumps, BookHive catalog, the review
-- CLI, and `pnpm run images:refresh`) is gone; with no producer of
-- `staged` rows, every PDS / listRecords query sees everything in the
-- lifecycle tables. The `released_filter` gate, `import_issues` issues
-- table, `book_import_issues` view, and `catalog_blobs` blob table were
-- all part of that pipeline. AppView reads are still served from
-- Google Books (see src/google-books/), not from these tables.
--
-- See also: migration 0008 which dropped the work-side staging tables
-- and the OL import bookkeeping tables.

-- Drop the per-entity import-issues view first (depends on import_issues + books).
-- drizzle-kit doesn't track views, so this line is appended manually.
DROP VIEW IF EXISTS "public"."book_import_issues";--> statement-breakpoint
ALTER TABLE "catalog_blobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_issues" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "catalog_blobs" CASCADE;--> statement-breakpoint
DROP TABLE "import_issues" CASCADE;--> statement-breakpoint
ALTER TABLE "books" DROP CONSTRAINT "books_release_status_check";--> statement-breakpoint
ALTER TABLE "contributor_roles" DROP CONSTRAINT "contributor_roles_release_status_check";--> statement-breakpoint
ALTER TABLE "contributors" DROP CONSTRAINT "contributors_release_status_check";--> statement-breakpoint
ALTER TABLE "genres" DROP CONSTRAINT "genres_release_status_check";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "release_status";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "released_at";--> statement-breakpoint
ALTER TABLE "contributor_roles" DROP COLUMN "release_status";--> statement-breakpoint
ALTER TABLE "contributor_roles" DROP COLUMN "released_at";--> statement-breakpoint
ALTER TABLE "contributors" DROP COLUMN "release_status";--> statement-breakpoint
ALTER TABLE "contributors" DROP COLUMN "released_at";--> statement-breakpoint
ALTER TABLE "genres" DROP COLUMN "release_status";--> statement-breakpoint
ALTER TABLE "genres" DROP COLUMN "released_at";