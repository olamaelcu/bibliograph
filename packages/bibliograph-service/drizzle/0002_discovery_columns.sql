-- drizzle/0002_discovery_columns.sql
-- Add cover_image_url to editions so Google Books enrichment can persist
-- discovered covers for future lookups. Nullable; existing rows unchanged.
ALTER TABLE "editions" ADD COLUMN "cover_image_url" text;