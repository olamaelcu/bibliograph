-- Backfill bookkeeping for description (editions, works) and bio (contributors).
-- Adding `checked_at` columns lets each scan distinguish "not yet looked"
-- from "looked, nothing found", making backfill loops finite.
ALTER TABLE editions ADD COLUMN IF NOT EXISTS description_checked_at timestamp with time zone;
ALTER TABLE works ADD COLUMN IF NOT EXISTS description_checked_at timestamp with time zone;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS bio_checked_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS editions_description_checked_at_idx ON editions (description_checked_at);
CREATE INDEX IF NOT EXISTS works_description_checked_at_idx ON works (description_checked_at);
CREATE INDEX IF NOT EXISTS contributors_bio_checked_at_idx ON contributors (bio_checked_at);
