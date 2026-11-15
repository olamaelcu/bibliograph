-- 0017-entity-search-indexes.sql
--
-- Indexes for contributor and publisher search.
--
-- `searchContributors` and `searchPublishers` matched a name or an identifier
-- value in one `OR` over the whole table: `contributors` (78k rows) took 190 ms
-- and `publishers` (31k) 10 ms, because an `OR` with an `EXISTS` branch can use
-- no index at all — the planner falls back to a sequential scan with the
-- subquery run per row. The read is now two index-backed sets joined together,
-- so the branches need their own indexes:
--
--   * `contributors.name` already has one (0016).
--   * `publishers.name` had none.
--   * The identifier branch only ever concerns entities that carry identifiers
--     at all, so it rides a partial index; everything else skips the row without
--     detoasting its `identifiers` column (26 ms of the scan was that alone).
--
-- Same transaction and lock story as 0016: deploy.sh stops the worker before
-- applying files, and a build blocks writers, not readers.

BEGIN;

CREATE INDEX IF NOT EXISTS publishers_name_trgm_idx
  ON publishers USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contributors_with_identifiers_idx
  ON contributors (id) WHERE identifiers <> '[]'::jsonb;

CREATE INDEX IF NOT EXISTS publishers_with_identifiers_idx
  ON publishers (id) WHERE identifiers <> '[]'::jsonb;

COMMIT;
