-- 0018-feed-order-nulls-last.sql
--
-- The feed's order index could never be used.
--
-- 0003 created `happyview_records_feed_order_idx` as
-- `(collection, (record::jsonb ->> 'createdAt') DESC, uri DESC)`. `DESC`
-- defaults to `NULLS FIRST`, while the feed pages `DESC NULLS LAST` (a record
-- with no `createdAt` sorts last, never first), so the index could not supply
-- the order: `EXPLAIN` showed a sequential scan of every record in the three
-- activity collections plus a top-N sort, measured 8.5 s for one page on the
-- production catalogue. With the NULLS order matching, the same page is three
-- index scans merged and stopped after `limit + 1` rows: 0.8 ms.
--
-- The index is replaced under the same name, so 0003's `IF NOT EXISTS` stays a
-- no-op on later deploys and this file converges instead of rebuilding the index
-- on every run. Conditional on HappyView's table, like 0003: on a fresh database
-- the catalog schema is applied before HappyView boots, and 0003's post-boot
-- re-apply creates the same (now corrected) definition.

BEGIN;

DO $do$
BEGIN
  IF to_regclass('happyview.happyview_records') IS NULL THEN
    RAISE NOTICE '0018-feed-order-nulls-last: happyview.happyview_records is not present; skip';
    RETURN;
  END IF;

  -- Only the NULLS FIRST definition is wrong; a converged host keeps its index.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'happyview'
       AND indexname = 'happyview_records_feed_order_idx'
       AND indexdef NOT LIKE '%NULLS LAST%'
  ) THEN
    DROP INDEX happyview.happyview_records_feed_order_idx;
  END IF;

  EXECUTE $index$
    CREATE INDEX IF NOT EXISTS happyview_records_feed_order_idx
      ON happyview.happyview_records
        (collection, (record::jsonb ->> 'createdAt') DESC NULLS LAST, uri DESC)
  $index$;
END
$do$;

COMMIT;
