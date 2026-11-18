-- 0000-rename-editions-to-books.sql
--
-- The catalog's top-level entity is a book: one row is one
-- `community.lexicon.media.book.edition` record, and the table is named after
-- the storage entity rather than the record's kind. Every later file is written
-- against `books`.
--
-- This file sorts *before* 0001 on purpose. `deploy.sh` replays every file on
-- every deploy, so on an existing database the rename has to happen before the
-- rewritten schema files run: `CREATE TABLE IF NOT EXISTS books` in 0001 would
-- otherwise create an empty `books` first and the rename would find the name
-- taken. On a fresh database there is nothing to rename, and 0001 creates
-- `books` directly.
--
-- Only the table is renamed. Its columns, indexes, constraints, triggers,
-- functions and sequence keep their names (`editions_next_tid()`,
-- `editions_pkey`, `editions_title_trgm_idx`, …), and so do the satellite
-- tables: `edition_identifiers.edition_uri` still references `books.uri`, and
-- `edition_uri` stays the column every join links on.
--
-- A database that already has both tables is not a state this file can resolve
-- — a replay against an un-rewritten 0001 created the empty `books` — so it
-- raises instead of silently leaving two catalogs behind.

BEGIN;

DO $rename$
BEGIN
  IF to_regclass('public.books') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_class
        WHERE oid = to_regclass('public.editions') AND relkind = 'r'
     ) THEN
    RAISE EXCEPTION
      'both public.editions and public.books exist; refusing to guess which one holds the catalog';
  END IF;

  -- Only a *table* is renamed. 0021 leaves a view named `editions` behind, and
  -- a replay must treat that as converged, not as the old catalog.
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = to_regclass('public.editions') AND relkind = 'r'
  ) THEN
    EXECUTE 'ALTER TABLE public.editions RENAME TO books';
    RAISE NOTICE '0000-rename-editions-to-books: renamed public.editions to public.books';
  END IF;
END
$rename$;

COMMIT;
