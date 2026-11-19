-- Historical: this file built the in-database search index
-- (`book_search`, its tsvector triggers and the backfill). Catalog search is
-- served by `bibliograph-search` now, and `0036-drop-book-search.sql` removes
-- the table and its triggers while moving the change queue onto its own
-- triggers.
--
-- The statements are deliberately gone rather than kept: `deploy.sh` replays
-- every file on every deploy, so keeping the table here would recreate it and
-- pay the full backfill each time, only for 0036 to drop it again.
SELECT 1;
