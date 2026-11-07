-- Cover backfill bookkeeping.
--
-- `cover_image_url IS NULL` alone is not a work queue: a row whose providers
-- have no cover stays NULL forever, so a scheduled scan would re-ask it every
-- tick. `cover_checked_at` records the lookup; the scanner skips rows checked
-- within the retry window and only the ones that predate it are asked again.
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "cover_checked_at" timestamp with time zone;
