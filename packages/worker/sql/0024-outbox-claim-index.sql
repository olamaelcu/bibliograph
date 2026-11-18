-- 0024-outbox-claim-index.sql
--
-- Give the outbox drain an index that matches its predicate and its order.
--
-- `claimBatch` (lib/publish.js) filters `collection = ANY($1)`, `next_at <=
-- now()`, `attempts < 10`, the lease and the optional `starts_with(uri, …)`
-- publisher prefix, then orders by `next_at, updated_at, uri` and takes a
-- `LIMIT`. `readOutboxStats` (lib/metrics.js) filters the same collections and
-- prefix and aggregates over the same attempt cap. The only index 0001 left for
-- that access path is `pds_outbox_ready_idx (next_at) WHERE attempts < 10`,
-- which has neither the collection filter nor the sort order: the drain read
-- and sorted rows the caller never wanted, and on the production outbox (tens
-- of millions of rows across several collections) it paid for the whole ready
-- set per batch.
--
-- The index below leads with `collection` (the equality filter), carries the
-- exact sort key the query orders by, and keeps the same `attempts < 10`
-- partial predicate as the query and as 0001's index. One ordered index scan
-- per drain and per scrape, stopping at the `LIMIT`.
--
-- `pds_outbox_ready_idx` stays: it is the cheapest path for an operator query
-- that looks at due rows without naming a collection, and this file never drops
-- anything a deployed database may still be using. Both files are re-applied on
-- deploy, so `IF NOT EXISTS` is what makes the second run a no-op.

BEGIN;

CREATE INDEX IF NOT EXISTS pds_outbox_claim_idx
  ON pds_outbox (collection, next_at, updated_at, uri)
  WHERE attempts < 10;

COMMIT;
