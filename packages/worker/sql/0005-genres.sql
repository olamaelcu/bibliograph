-- 0005-genres.sql
--
-- Edition genres: a curated vocabulary, the edition-to-genre links, and the
-- claim ledger that both queue paths share.
--
-- Genres are an edge-only read: `getGenresOfBook` answers them from these
-- tables like `getContributor` answers contributors. They are deliberately not
-- part of the published `community.lexicon.media.book.edition` record, so this
-- file adds no outbox trigger and leaves `appview_book` untouched (a
-- `CREATE OR REPLACE VIEW` cannot change a column list, and HappyView's
-- `edition_view` has no genre column).
--
-- `genres` is a shared vocabulary: one row per canonical name, linked to many
-- editions through `edition_genres`. Provider labels are mapped to canonical
-- names by the worker before they get here (`lib/genres.js`), so a row in
-- `genres` is always a curated name — `nyt:mass-market-monthly=2021-11-07` and
-- `Dune (Imaginary place)` never become rows.
--
-- Additive and idempotent, like 0001 and 0004: `IF NOT EXISTS` everywhere and
-- `CREATE OR REPLACE` for the function. It never drops, truncates or rewrites a
-- row.
--
-- `graphile_worker` does not exist until the worker first boots, so
-- `catalog_enqueue_genre_fetch` is created unconditionally: plpgsql resolves the
-- `add_job` call at run time, never at creation. Callers treat a missing
-- `graphile_worker` schema as "skip enqueue" — the catalog still serves reads.

BEGIN;

-- ---------------------------------------------------------------------------
-- Vocabulary and links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS genres (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Identity is the lowercased name, so `Science Fiction` and `science fiction`
-- are one genre. The worker's INSERT uses this index as its conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS genres_identity_idx ON genres (lower(name));

CREATE TABLE IF NOT EXISTS edition_genres (
  edition_uri text NOT NULL REFERENCES editions (uri) ON DELETE CASCADE,
  genre_id bigint NOT NULL REFERENCES genres (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  source text NOT NULL CHECK (source IN ('openlibrary', 'goodreads')),
  PRIMARY KEY (edition_uri, genre_id)
);

-- Serves the reverse walk (every edition of a genre); the primary key already
-- covers the forward one.
CREATE INDEX IF NOT EXISTS edition_genres_genre_idx ON edition_genres (genre_id);

-- ---------------------------------------------------------------------------
-- Fetch ledger
--
-- One row per edition ever queued for genre hydration. `outcome` is NULL while
-- a fetch is outstanding, then `found` or `none`. The row is also the retry
-- clock: an edition that genuinely has no genres is not asked again for seven
-- days, and a `found` row short-circuits a re-run without touching a provider.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_genre_fetches (
  edition_uri text PRIMARY KEY REFERENCES editions (uri) ON DELETE CASCADE,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  outcome text CHECK (outcome IN ('found', 'none'))
);

-- Ordered by the retry pass of `catalog.genres.sweep` (oldest attempt first),
-- so it must stay a plain column index.
CREATE INDEX IF NOT EXISTS edition_genre_fetches_requested_at_idx
  ON edition_genre_fetches (requested_at);

-- ---------------------------------------------------------------------------
-- Sweep index
--
-- `catalog.genres.sweep` walks editions that have no genres in `indexed_at`
-- order and stops at its LIMIT. 0001 indexes `created_at` but nothing indexed
-- `indexed_at`, so without this the sweep is a full scan of the largest table
-- plus a top-N sort every time it runs. With it the limit stops the walk after
-- a handful of index entries instead. `uri` is in the key so the sort order
-- matches the index order exactly and the planner never needs a sort node.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS editions_indexed_at_idx ON editions (indexed_at, uri);

-- ---------------------------------------------------------------------------
-- The single enqueue entry point
--
-- Both the edge (`enqueueGenreFetch`) and the sweep task call this, so the
-- claim-and-enqueue logic exists once. It is the genre analogue of
-- `catalog_enqueue_marks` in the web package, with the difference that the
-- ledger row doubles as the "does this edition have genres" state.
--
-- Returns true only when a job was actually queued. `ON CONFLICT … WHERE`
-- makes the SUCCEEDING insert the claim: a fresh row, or one older than the
-- seven-day window, yields a row and therefore `true`; a recent row yields
-- nothing and the function returns false without calling the worker.
--
-- `json_build_object` (not jsonb) because `add_job`'s `payload` parameter is
-- `json`. A failed enqueue deletes the claim it just made, so the next caller
-- can retry instead of waiting out the window.
-- ---------------------------------------------------------------------------

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
      max_attempts := 5
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM edition_genre_fetches
     WHERE edition_uri = target_uri AND outcome IS NULL;
    RAISE;
  END;

  RETURN true;
END;
$function$;

COMMIT;
