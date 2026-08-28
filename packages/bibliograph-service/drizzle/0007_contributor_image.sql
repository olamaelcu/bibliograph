-- drizzle/0007_contributor_image.sql
-- Add author-photo metadata columns to `contributors` so the
-- `net.olamaelcu.livtet.biblio.getImageForContributor` XRPC can return a
-- cached url alongside its Commons license / artist metadata. The image
-- is NOT in the community record (`community.lexicon.book.contributor`)
-- so this doesn't affect the record CID.
--
-- `image_checked_at` is the permanent-miss guard: set on every lookup
-- attempt (hit OR miss) so an author with no resolvable photo is not
-- retried on every page render. Resolver treats NULL as "never tried"
-- and anything else as "checked at <timestamp>; trust the cached
-- values until they are explicitly cleared".
--
-- `image_url` is nullable: a row that has been checked but produced no
-- result keeps the row present with image_checked_at set.

ALTER TABLE "contributors" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_source" text;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_artist" text;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_license" text;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_license_url" text;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_attribution_required" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "image_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contributors_image_checked_at_idx" ON "contributors" ("image_checked_at");--> statement-breakpoint