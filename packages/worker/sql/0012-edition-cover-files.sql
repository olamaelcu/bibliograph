-- 0012-edition-cover-files.sql
--
-- Cover bytes live on disk, keyed by the edition at-URI. This file records
-- which books have a usable cached image and what it is, so the edge can
-- answer Content-Type/Length without touching the image header, and the sweep
-- can tell "not cached yet" from "cached".
--
-- `source_url` is the provider URL the bytes were fetched from: when a curator
-- edits `books.cover_url`, the cache row no longer matches and the worker
-- re-downloads. `edition_cover_fetches` gains the same column so a `rejected`
-- outcome is terminal only for the URL that was actually rejected.
--
-- Additive and idempotent, like 0001/0004/0005/0009.

BEGIN;

CREATE TABLE IF NOT EXISTS edition_cover_files (
  edition_uri text PRIMARY KEY REFERENCES books (uri) ON DELETE CASCADE,
  source_url text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  cached_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE edition_cover_fetches ADD COLUMN IF NOT EXISTS source_url text;

-- Placeholder-sized images are terminal: retrying the same URL wastes a
-- provider request every seven days.
ALTER TABLE edition_cover_fetches
  DROP CONSTRAINT IF EXISTS edition_cover_fetches_outcome_check;
ALTER TABLE edition_cover_fetches
  ADD CONSTRAINT edition_cover_fetches_outcome_check
  CHECK (outcome IN ('found', 'none', 'rejected'));

-- The sweep's "has a source URL but no cached file" walk, ordered by
-- `indexed_at` so the LIMIT ends it.
CREATE INDEX IF NOT EXISTS editions_cover_url_idx
  ON books (indexed_at, uri)
  WHERE cover_url IS NOT NULL AND btrim(cover_url) <> '';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    EXECUTE 'GRANT SELECT ON edition_cover_files TO happyview_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bibliograph-web') THEN
    EXECUTE 'GRANT SELECT ON edition_cover_files TO "bibliograph-web"';
  END IF;
END
$do$;

COMMIT;
