-- ISBN enrichment bookkeeping.
--
-- Until now there was no way to tell "this edition has no ISBN" apart from "we
-- have not looked", so a backfill would re-query OpenLibrary and Google Books
-- for the same ISBN-less book on every run.
--
-- A separate table rather than columns on `editions`: the enrichment state is
-- bookkeeping, not part of the record, and keeping it out of `editions` leaves
-- the served edition shape (and every caller that builds an `EditionRow`)
-- untouched.
--
--   checked_at  when the backfill last looked at this edition
--   result      found | shadow | ambiguous | none
--   candidates  what tier 2 scored, kept for review while it runs in shadow
--               mode (accepted and rejected candidates, with reasons)
CREATE TABLE IF NOT EXISTS edition_isbn_enrichment (
  uri text PRIMARY KEY REFERENCES editions (uri) ON DELETE CASCADE,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  result text NOT NULL,
  candidates jsonb
);

-- The scan is "editions with no enrichment row yet", so the join key is the
-- lookup path; the primary key already indexes it.
CREATE INDEX IF NOT EXISTS edition_isbn_enrichment_checked_at_idx
  ON edition_isbn_enrichment (checked_at);
