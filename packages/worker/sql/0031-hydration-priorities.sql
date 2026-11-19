-- 0031-hydration-priorities.sql
--
-- Graphile runs jobs in ascending `(priority, run_at)` order, and every job was
-- queued at the default priority 0. A sweeps backlog therefore starved
-- everything newer: with ~1,400 `catalog.genres` jobs due, the per-minute
-- `pds-publish` cron — whose `run_at` is newer than any of them — waited behind
-- the whole batch. The outbox grew and `pds_cids` did not move for a minute
-- while the publishers were up.
--
-- Three classes now:
--
--   1. `pds-publish` (the cron, in `index.js`) is priority -10: publishing is
--      what makes a record visible on the network, so it never queues behind
--      hydration.
--   2. Edge-triggered hydration (`catalog.resolve`, `catalog.search`,
--      `catalog.isbn`) stays at 0: a user is waiting for the enrichment.
--   3. Bulk sweeps' per-edition work is priority 100: one edition's genre or
--      cover is not urgent, and the ledger retries it anyway.
--
-- The functions are replaced rather than new: `0005`, `0009` and `0028` created
-- them, and every replay of those files runs before this one. The guarded
-- UPDATE re-prioritises work already queued under the old policy; it is skipped
-- on a database without graphile's schema (the schema checks).

BEGIN;

CREATE OR REPLACE FUNCTION catalog_enqueue_genre_fetch(target_uri text)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO edition_genre_fetches (edition_uri, requested_at, outcome)
  VALUES (target_uri, now(), NULL)
  ON CONFLICT (edition_uri) DO UPDATE
    SET requested_at = now(), outcome = NULL
    WHERE edition_genre_fetches.requested_at < now() - interval '7 days'
  RETURNING true INTO claimed;

  IF claimed IS NOT TRUE THEN
    RETURN false;
  END IF;

  BEGIN
    PERFORM graphile_worker.add_job(
      identifier := 'catalog.genres',
      payload := json_build_object('editionUri', target_uri),
      job_key := 'genres:' || target_uri,
      max_attempts := 5,
      priority := 100
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_genre_fetches
     WHERE edition_uri = target_uri AND outcome IS NULL;
    RAISE;
  END;

  RETURN true;
END;
$function$;

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
      max_attempts := 5,
      priority := 100
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_cover_fetches
     WHERE edition_uri = target_uri AND outcome IS NULL;
    RAISE;
  END;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION catalog_enqueue_isbn_backfill(target_uri text)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO edition_isbn_backfill (edition_uri, requested_at, outcome)
  VALUES (target_uri, now(), 'skipped')
  ON CONFLICT (edition_uri) DO UPDATE
    SET requested_at = now(), outcome = 'skipped', source = NULL, isbn = NULL
    WHERE edition_isbn_backfill.requested_at < now() - interval '7 days'
  RETURNING true INTO claimed;

  IF claimed IS NOT TRUE THEN
    RETURN false;
  END IF;

  BEGIN
    PERFORM graphile_worker.add_job(
      identifier := 'catalog.isbn.backfill',
      payload := json_build_object('editionUri', target_uri),
      job_key := 'isbn-backfill:' || target_uri,
      queue_name := 'isbn-backfill',
      max_attempts := 3,
      priority := 100
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_isbn_backfill
     WHERE edition_uri = target_uri AND outcome = 'skipped';
    RAISE;
  END;

  RETURN true;
END;
$function$;

-- One-time: work already queued at the default priority belongs to the bulk
-- class, otherwise it keeps starving everything created after it.
DO $reprioritise$
BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NULL THEN
    RETURN;
  END IF;

  UPDATE graphile_worker._private_jobs j
     SET priority = 100
    FROM graphile_worker._private_tasks t
   WHERE t.id = j.task_id
     AND j.priority = 0
     AND t.identifier IN ('catalog.genres', 'catalog.covers', 'catalog.isbn.backfill');
END
$reprioritise$;

COMMIT;
