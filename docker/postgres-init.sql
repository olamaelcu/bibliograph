-- Local compose stack: HappyView needs its own schema and login role because
-- its sqlx migrations are unqualified. The role's default search_path keeps
-- its tables (including `labels`) out of the catalog's `public` schema.
CREATE SCHEMA IF NOT EXISTS happyview;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    CREATE ROLE happyview_app LOGIN PASSWORD 'happyview';
  END IF;
END $$;

ALTER ROLE happyview_app SET search_path = happyview, public;

GRANT USAGE, CREATE ON SCHEMA happyview TO happyview_app;
GRANT USAGE ON SCHEMA public TO happyview_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO happyview_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bibliograph IN SCHEMA public
  GRANT SELECT ON TABLES TO happyview_app;

-- The local atproto network shares this server: the PLC directory is the only
-- local atproto service that owns a Postgres database. Created here so a fresh
-- `pgdata` comes up complete; `mise run hv-dbs` applies the same statement to
-- an existing volume.
SELECT 'CREATE DATABASE plc' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'plc')\gexec
