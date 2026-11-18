-- 0021-editions-compat-view.sql
--
-- `0000` renamed the catalog table to `books`. This view keeps the old name
-- readable for one release, so a reverted edge package (or any reader still
-- saying `editions`) can still read the catalog.
--
-- It is a plain auto-updatable view, which means SELECT, plain
-- INSERT/UPDATE/DELETE and RETURNING work through it — but `INSERT … ON
-- CONFLICT` does not: PostgreSQL infers the conflict target from a table's
-- unique constraints, and a view exposes none, so it fails at plan time with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" before any trigger could run. The worker's and the admin's
-- write paths are all upserts, so they must name `books`. Rolling the worker
-- back therefore means
--
--   DROP VIEW editions;
--   ALTER TABLE books RENAME TO editions;
--
-- with the reverted packages, not a write against this view.
--
-- `0022-drop-editions-view.sql` removes the view. Every replay creates it here
-- and drops it there, so the converged state is always "no view".
--
-- `SELECT *` is expanded when the view is created: a later migration that adds
-- a column to `books` must re-create this view (a `CREATE OR REPLACE` cannot
-- change the column list).

BEGIN;

CREATE OR REPLACE VIEW public.editions AS SELECT * FROM public.books;

-- Same guarded grant as 0001: a test container has no HappyView role, and the
-- compatibility view has to be readable by the roles that can read the table.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    EXECUTE 'GRANT SELECT ON public.editions TO happyview_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bibliograph-web') THEN
    EXECUTE 'GRANT SELECT ON public.editions TO "bibliograph-web"';
  END IF;
END
$grant$;

COMMIT;
