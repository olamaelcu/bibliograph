-- 0006-genre-sources.sql
--
-- ISBNdb becomes a third genre source, so `edition_genres.source` must accept
-- it. 0005's inline CHECK allowed only the two free providers; a genre fetched
-- from ISBNdb would violate it and abort the whole genre write.
--
-- This is a widened constraint, not a data change: no row is added, dropped or
-- rewritten, and every value already stored still satisfies the new predicate.
-- The constraint is replaced NOT VALID and then validated, so an existing
-- catalogue is checked once instead of taking a validating lock on ADD.
--
-- Idempotent: the DROP is conditional and the ADD is the only statement that
-- creates the constraint, so re-applying the file replaces it with the same
-- definition.

BEGIN;

ALTER TABLE edition_genres
  DROP CONSTRAINT IF EXISTS edition_genres_source_check;

ALTER TABLE edition_genres
  ADD CONSTRAINT edition_genres_source_check
  CHECK (source IN ('openlibrary', 'goodreads', 'isbndb')) NOT VALID;

ALTER TABLE edition_genres
  VALIDATE CONSTRAINT edition_genres_source_check;

COMMIT;
