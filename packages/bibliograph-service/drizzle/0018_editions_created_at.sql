-- `getEditionsByContributor` orders by the catalog record's own `created_at`,
-- not by the batch-import time in `indexed_at`.
--
-- `editions.created_at` is written from the record at ingest
-- (`new Date(item.createdAt)`), so it is the stamp a reader means by recency;
-- `indexed_at` is when a batch last touched the row, which put 238k catalog rows
-- in import order. The order change needs its own index: the old one scanned
-- `editions_indexed_at_idx` backwards and stopped after `limit` matching rows, and
-- without an equivalent index the contributor filter (an `EXISTS` over
-- `jsonb_array_elements(contributors)`, which cannot use an index) would have to
-- scan and sort every match.
CREATE INDEX IF NOT EXISTS "editions_created_at_idx"
  ON "editions" USING btree ("created_at" DESC, "uri");
