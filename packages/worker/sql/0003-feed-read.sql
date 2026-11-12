-- 0003-feed-read.sql
--
-- Read path for the edge feed generator (`com.atproto.feed.*`).
--
-- The feed generator lives in packages/web and pages
-- `happyview.happyview_records` directly: newest first by the record's own
-- `createdAt`, then `uri` descending, optionally filtered to a viewer's follow
-- set. That needs two indexes HappyView's own migrations do not create, plus
-- schema/table privileges for the web role.
--
-- This file is conditional on the table existing: HappyView owns the schema and
-- creates `happyview_records` from its own migrations. On a fresh database the
-- catalog schema is applied before HappyView boots, so both blocks here are
-- skipped rather than failing; re-running after HappyView has created the table
-- adds the indexes and grants. It never touches a row.
--
-- Idempotent by construction: `IF NOT EXISTS` for the indexes, plain
-- (repeatable) GRANTs.

BEGIN;

DO $do$
BEGIN
  IF to_regclass('happyview.happyview_records') IS NULL THEN
    RAISE NOTICE '0003-feed-read: happyview.happyview_records is not present; skip feed indexes/grants';
    RETURN;
  END IF;

  EXECUTE $index$
    CREATE INDEX IF NOT EXISTS happyview_records_feed_order_idx
      ON happyview.happyview_records
        (collection, (record::jsonb ->> 'createdAt') DESC, uri DESC)
  $index$;

  EXECUTE $index$
    CREATE INDEX IF NOT EXISTS happyview_records_follow_subject_did_idx
      ON happyview.happyview_records
        (did, collection, ((record::jsonb ->> 'subject')))
  $index$;

  EXECUTE format('GRANT USAGE ON SCHEMA happyview TO %I', current_user);
  EXECUTE format('GRANT SELECT ON happyview.happyview_records TO %I', current_user);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bibliograph-web') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA happyview TO "bibliograph-web"';
    EXECUTE 'GRANT SELECT ON happyview.happyview_records TO "bibliograph-web"';
  END IF;
END
$do$;

COMMIT;
