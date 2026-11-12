-- One-time database setup for HappyView, in the shared-database layout where
-- its tables live in their own `happyview` schema beside the application's
-- `public` tables (its `labels` table collides with the app's labeler).
--
-- Run once as a Postgres superuser, then put the role's URL in
-- /etc/bibliograph/happyview.env:
--
--   sudo -u postgres psql -v db=bibliograph -f /usr/share/bibliograph-happyview/db-init.sql
--   # then, in /etc/bibliograph/happyview.env:
--   # DATABASE_URL=postgres://happyview_app:change-me@localhost/bibliograph
--
-- Change the password before running. This script is idempotent except for
-- CREATE ROLE, which answers "already exists" on a second run — expected.
--
-- If HappyView gets its own database instead, skip the schema indirection:
-- create the role and database, leave the role's search_path alone, and run
-- this file's final GRANT lines only.

\set ON_ERROR_STOP on

CREATE ROLE happyview_app LOGIN PASSWORD 'change-me';
ALTER ROLE happyview_app SET search_path = happyview, public;

\connect :db

CREATE SCHEMA IF NOT EXISTS happyview AUTHORIZATION happyview_app;
GRANT USAGE ON SCHEMA public TO happyview_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO happyview_app;
