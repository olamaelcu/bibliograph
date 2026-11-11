-- Local compose stack: HappyView needs its own schema and login role because
-- sqlx migrations are unqualified and its `labels` table collides with the
-- AppView's. The role's default search_path is what keeps them apart.
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
