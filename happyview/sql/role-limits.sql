-- Connection limits for HappyView's runtime pool.
--
-- The runtime holds its connections for the life of the process: measured 71
-- idle backends under `happyview_app` during a network backfill, against 10 at
-- steady state, on a cluster where `max_connections = 100` and bibliograph
-- (catalog pool 15 + feed pool 5), the worker and the exporter also live. Those
-- 71 idle sessions served nothing and left the catalogue's own reads queueing.
--
-- 40 is roughly 4x the busiest steady observation and still leaves >=30
-- connections for everyone else at their maxima (bibliograph 21 + exporter 3 +
-- superuser reserve 3). `idle_session_timeout` is the half that does the work:
-- the runtime has no idle reaper, so idle sessions are closed server-side and
-- its pool reconnects on demand. Deliberately not
-- `idle_in_transaction_session_timeout`, which only covers sessions holding an
-- open transaction and is already 60s in the cluster tuning.
--
-- Needs a superuser: `hv-deploy` connects as `bibliograph`, so on an installed
-- host this file is applied by the postgres Ansible role (or by hand as
-- `postgres`) and the deploy run records the skip as a notice. It lives here so
-- the numbers sit beside the schema they describe, and so a review of that
-- schema sees them.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
        RAISE NOTICE 'happyview_app is absent; no connection limits to apply';
        RETURN;
    END IF;

    EXECUTE 'ALTER ROLE happyview_app CONNECTION LIMIT 40';
    EXECUTE 'ALTER ROLE happyview_app SET idle_session_timeout = ''120s''';
    RAISE NOTICE 'happyview_app: connection limit 40, idle_session_timeout 120s';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE
            'skipping happyview_app connection limits: this role is not a superuser (see the ansible postgres role)';
END
$$;
