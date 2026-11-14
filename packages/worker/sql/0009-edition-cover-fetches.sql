-- 0009-edition-cover-fetches.sql
--
-- A cover only ever arrives with an ingested provider candidate
-- (`fillMissingFields`), so an edition whose first provider had no cover stays
-- coverless forever. This file gives the catalog what the genre backfill already
-- has: a ledger of attempted fetches and a single claim-and-enqueue entry point,
-- shared by the edge and the scheduled sweep.
--
-- Unlike genres, a cover can be filled later without a provider re-ingest, so
-- `catalog.covers` asks OpenLibrary (and Google Books for an ISBN) for a picture
-- only. `outcome` is NULL while a fetch is outstanding, then `found` or `none`;
-- `found` is terminal, `none` is retried on the sweep's seven-day clock.
--
-- Additive and idempotent, like 0001/0004/0005: `IF NOT EXISTS` everywhere and
-- `CREATE OR REPLACE` for the function.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fetch ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_cover_fetches (
  edition_uri text PRIMARY KEY REFERENCES editions (uri) ON DELETE CASCADE,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  outcome text CHECK (outcome IN ('found', 'none'))
);

-- Serves the sweep's first pass: the walk is index-only-sized when nothing is
-- coverless, and the LIMIT stops it after a handful of entries otherwise.
CREATE INDEX IF NOT EXISTS editions_missing_cover_idx
  ON editions (indexed_at, uri)
  WHERE cover_url IS NULL OR btrim(cover_url) = '';

-- Retry pass: oldest attempt first, and `found` rows are not retried.
CREATE INDEX IF NOT EXISTS edition_cover_fetches_retry_idx
  ON edition_cover_fetches (requested_at)
  WHERE outcome IS DISTINCT FROM 'found';

-- ---------------------------------------------------------------------------
-- The single enqueue entry point
--
-- The structural twin of `catalog_enqueue_genre_fetch` (0005): the SUCCEEDING
-- insert is the claim, so a fresh row — or one older than the seven-day window —
-- yields a job and a recent row yields nothing. A failed enqueue deletes the
-- claim it just made, so the next caller can retry instead of waiting out the
-- window.
--
-- `graphile_worker` does not exist until the worker first boots, so the function
-- is created unconditionally: plpgsql resolves `add_job` at run time, never at
-- creation. Callers treat a missing schema as "skip enqueue".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION catalog_enqueue_cover_fetch(target_uri text)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO edition_cover_fetches (edition_uri, requested_at, outcome)
  VALUES (target_uri, now(), NULL)
  ON CONFLICT (edition_uri) DO UPDATE
    SET requested_at = now(), outcome = NULL
    WHERE edition_cover_fetches.requested_at < now() - interval '7 days'
  RETURNING true INTO claimed;

  IF claimed IS NOT TRUE THEN
    RETURN false;
  END IF;

  BEGIN
    PERFORM graphile_worker.add_job(
      identifier := 'catalog.covers',
      payload := json_build_object('editionUri', target_uri),
      job_key := 'cover:' || target_uri,
      max_attempts := 5
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_cover_fetches
     WHERE edition_uri = target_uri AND outcome IS NULL;
    RAISE;
  END;

  RETURN true;
END;
$function$;

COMMIT;
