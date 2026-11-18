-- 0028-isbn-backfill.sql
--
-- An ISBN is the cheapest identity the catalog can have: it is what OpenLibrary
-- and Goodreads can be asked about without metering, and what the ingest
-- identifier bag joins on. Roughly a hundred thousand books carry none — they
-- arrived from Bookhive, Goodreads or OpenLibrary and kept only that provider's
-- id — so this file gives those books the same claim-and-enqueue shape the
-- genre (0005) and cover (0009) backfills already use: a ledger row per
-- edition, a seven-day retry clock, and one function that both the scheduled
-- sweep and any future edge call go through.
--
-- The task behind the job (`catalog.isbn.backfill`) only ever asks the free
-- providers, and it refuses to run past a daily budget, so the ledger's outcome
-- is also the spend record: `found` + `none` + `conflict` counted for today is
-- exactly how many provider queries the backfill has made.
--
-- Additive and idempotent, like 0001/0005/0009: `IF NOT EXISTS` everywhere and
-- `CREATE OR REPLACE` for the function. It never drops, truncates or rewrites a
-- row.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fetch ledger
--
-- One row per edition ever queued for an ISBN lookup. `outcome` is written
-- `skipped` the moment the claim is taken (the column has no NULL state, unlike
-- 0005's ledger), then replaced by the task with one of:
--
--   found     the edition now carries the ISBN the lookup found
--   none      every free provider answered and none knew an ISBN for this book
--   conflict  an ISBN was found, but another edition already owns it
--   skipped   nothing to do (the edition already had an ISBN, or the claim was
--             still fresh and no attempt has happened yet)
--
-- `source` and `isbn` keep the evidence behind `found`/`conflict`: which
-- provider answered, and what it said. `requested_at` is the retry clock, as in
-- the two older ledgers.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_isbn_backfill (
  edition_uri text PRIMARY KEY REFERENCES books (uri) ON DELETE CASCADE,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('found', 'none', 'conflict', 'skipped')),
  source text,
  isbn text
);

-- Ordered by the retry pass of `catalog.isbn.backfill.sweep` (oldest attempt
-- first), so it stays a plain column index: that pass walks it in `requested_at`
-- order and stops at its LIMIT.
CREATE INDEX IF NOT EXISTS edition_isbn_backfill_retry_idx
  ON edition_isbn_backfill (requested_at);

-- ---------------------------------------------------------------------------
-- The single enqueue entry point
--
-- The structural twin of `catalog_enqueue_genre_fetch` (0005): the SUCCEEDING
-- insert is the claim, so a fresh row — or one older than the seven-day window —
-- yields a job, and a recent row yields nothing. A failed enqueue deletes the
-- claim it just made, so the next caller can retry instead of waiting out the
-- window.
--
-- Two deliberate differences from 0005:
--
--   * the claim inserts `outcome = 'skipped'`, because this ledger has no NULL
--     state; the task replaces it with the real answer. Re-claiming also clears
--     the previous `source`/`isbn`, so a `found` ISBN that was later curated
--     away cannot be mistaken for the new attempt's evidence.
--   * `queue_name := 'isbn-backfill'`: graphile-worker runs one job per named
--     queue at a time, which is what pins this backfill to concurrency 1 and
--     keeps its provider requests polite.
--
-- `graphile_worker` does not exist until the worker first boots, so the
-- function is created unconditionally: plpgsql resolves `add_job` at run time,
-- never at creation. Callers treat a missing schema as "skip enqueue" — the
-- catalog still serves reads.
-- ---------------------------------------------------------------------------

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
      max_attempts := 3
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_isbn_backfill
     WHERE edition_uri = target_uri AND outcome = 'skipped';
    RAISE;
  END;

  RETURN true;
END;
$function$;

COMMIT;
