-- 0014-bookhive-editions.sql
--
-- The hive id -> edition join the Bookhive reads need.
--
-- Bookhive names no edition: a reader's `buzz.bookhive.book` record carries the
-- catalog book's `hiveId` (`bk_…`) and nothing else. The import mints an
-- edition for every catalog book and records the hive id as a
-- `(bookhive.buzz, bk_…)` identifier, so this view is the whole translation —
-- it is what turns "the book the reader reviewed" into "the edition the
-- AppView serves".
--
-- `edition_identifiers_lookup_idx` ((issuer, value)) serves both directions:
-- edition -> hive ids (the reviews of one book) and hive id -> edition (one
-- actor's reviews, and the feed's reason).

BEGIN;

CREATE OR REPLACE VIEW appview_bookhive_lua AS
SELECT i.value AS hive_id, i.edition_uri
  FROM edition_identifiers i
 WHERE i.issuer = 'bookhive.buzz';

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    EXECUTE 'GRANT SELECT ON appview_bookhive_lua TO happyview_app';
  END IF;
END
$migration$;

COMMIT;
