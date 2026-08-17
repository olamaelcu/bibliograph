DROP INDEX "contributor_identifiers_url_idx";--> statement-breakpoint
DROP INDEX "contributors_name_idx";--> statement-breakpoint
ALTER TABLE "jetstream_cursor" ALTER COLUMN "cursor" SET DATA TYPE bigint;