-- Genre fetches were the last thing in the queue, by accident.
--
-- `catalog_enqueue_genre_fetch` called `add_job` without a priority, so the
-- job took graphile's default 0 and queued FIFO behind every other priority-0
-- job. On the host that meant a multi-day backlog: 1 844 `catalog.search`, 613
-- `catalog.resolve` (retrying against an open provider breaker) and 619
-- `catalog.covers`, all older than the genre jobs, at a worker concurrency of 2.
-- Genre hydration stopped on 2026-11-19 01:04 and did not resume.
--
-- A genre fetch is a user-facing read miss (the edge queues it when a reader
-- opens a book), so it belongs above the bulk sweeps, next to publishing:
-- priority -5, between `pds-publish` (-10) and the default 0. The jobs already
-- queued at 100 (an older form of this function passed it explicitly) are moved
-- up as well; they would otherwise never be selected while priority-0 work
-- exists.
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
      priority := -5
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_genre_fetches
     WHERE edition_uri = target_uri AND outcome IS NULL;
    RAISE;
  END;

  RETURN true;
END;
$function$;

-- A database without graphile (the tests' container) has no queue to move.
DO $do$
BEGIN
  -- `jobs` is a view over `_private_jobs` (not updatable) and the identifier
  -- lives in `tasks`; a database without graphile (the tests' container) has
  -- neither.
  IF to_regclass('graphile_worker._private_jobs') IS NOT NULL
     AND to_regclass('graphile_worker.tasks') IS NOT NULL THEN
    UPDATE graphile_worker._private_jobs j
       SET priority = -5
      FROM graphile_worker.tasks t
     WHERE t.id = j.task_id
       AND t.identifier = 'catalog.genres'
       AND j.priority = 100;
  END IF;
END
$do$;
