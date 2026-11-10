-- Performance index pass.
--
-- Four additive indexes; nothing is rewritten, nothing is dropped. Each backs
-- an access pattern measured in production-shaped queries:
--
-- 1. `contributor-name-resolver.ts` probes `lower(name) = lower($1)` once per
--    author per search enrichment. Without this index that is a sequential
--    scan of `contributors`.
CREATE INDEX IF NOT EXISTS contributors_lower_name_idx ON contributors (lower(name));
-- 2. Seniority evaluation and the admin screens filter `labels` on `val`
--    alone; no supporting index existed (labels grew unboundedly).
CREATE INDEX IF NOT EXISTS labels_val_idx ON labels (val);
-- 3. The cover backfill's pending scan filters `editions` on `cover_checked_at`
--    (added in 0027 without an index).
CREATE INDEX IF NOT EXISTS editions_cover_checked_at_idx ON editions (cover_checked_at);
-- 4. The social feeds filter `records` by `did` + `collection` and order by
--    `record_created_at`. The composite serves the filter and the order from
--    one index instead of ordering the whole matching subset at read time.
--    `record_created_at` is the generated coalesce column from 0017, already
--    used by `newestRecordFirst()`.
CREATE INDEX IF NOT EXISTS records_did_collection_created_at_idx
  ON records (did, collection, record_created_at DESC, uri DESC);
