-- 0020-feed-popfeed.sql
--
-- The feed pages social.popfeed.feed.review and social.popfeed.feed.listItem.
--
-- Popfeed's shelf entries (`listItem`) carry no `createdAt`: their activity time
-- is `addedAt`, and a review carries both shapes' worth of nothing else. The
-- feed orders and paces by `COALESCE(createdAt, addedAt)`, so the order index
-- has to be on that expression — on the old `createdAt`-only definition every
-- `listItem` would be a NULL key, and a page would have to walk all of them.
--
-- The index is replaced under the same name, so 0003's `IF NOT EXISTS` stays a
-- no-op on later deploys and this file converges instead of rebuilding the index
-- on every run. Conditional on HappyView's table, like 0003 and 0018: on a fresh
-- database the catalog schema is applied before HappyView boots, and the
-- post-boot re-apply in deploy.sh creates the definition this file wants.
--
-- The grant is new: resolving a Popfeed record's ISBN/ASIN to a catalog edition
-- is the feed query's first read of `public.edition_identifiers`, and the
-- production edge connects as `bibliograph-web`. 0001 grants the catalog tables
-- to `happyview_app` only, and 0012/0003 are the precedent for granting a
-- feed-read object to the web role explicitly.

BEGIN;

DO $do$
BEGIN
  IF to_regclass('happyview.happyview_records') IS NULL THEN
    RAISE NOTICE '0020-feed-popfeed: happyview.happyview_records is not present; skip';
    RETURN;
  END IF;

  -- Only the createdAt-only definition is wrong; a converged host keeps its index.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'happyview'
       AND indexname = 'happyview_records_feed_order_idx'
       AND indexdef NOT LIKE '%addedAt%'
  ) THEN
    DROP INDEX happyview.happyview_records_feed_order_idx;
  END IF;

  EXECUTE $index$
    CREATE INDEX IF NOT EXISTS happyview_records_feed_order_idx
      ON happyview.happyview_records
        (collection,
         (COALESCE(record::jsonb ->> 'createdAt', record::jsonb ->> 'addedAt')) DESC NULLS LAST,
         uri DESC)
  $index$;
END
$do$;

DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bibliograph-web') THEN
    EXECUTE 'GRANT SELECT ON public.edition_identifiers TO "bibliograph-web"';
  END IF;
END
$role$;

COMMIT;
