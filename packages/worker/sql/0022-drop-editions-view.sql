-- 0022-drop-editions-view.sql
--
-- Release A left `editions` as a view over `books` so a reverted edge package
-- could still read the catalogue while the host cut over. Both packages have
-- run against `books` since, so the alias goes.
--
-- Every replay creates the view in 0021 and drops it here, in that order, so
-- the converged state is always "no view" no matter how many times the
-- directory is applied.
--
-- Rolling the worker back from here is the reverse rename of 0000, with the
-- reverted packages installed:
--
--   ALTER TABLE books RENAME TO editions;
--
-- A dump taken before a rename release is still the reliable path; the rename
-- itself is metadata-only, so it is also the cheap one.

BEGIN;

DROP VIEW IF EXISTS public.editions;

COMMIT;
