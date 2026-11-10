-- Drop the dead indexes (performance finding #5).
--
-- All-time `pg_stat_user_indexes.idx_scan` on production (stats never reset
-- there): `publishers_did_idx` 0, `records_indexed_at_idx` 4, nothing in the
-- source reads either. Both only cost write-time maintenance.
--
-- `editions_search_idx` (the 0001 tsvector GIN) is intentionally NOT here —
-- 0005 already dropped it. `publishers_name_idx` never existed: schema.ts
-- declared it, no migration created it. `editions_did_idx` (226) and
-- `works_did_idx` (54) stay — they are not dead.
DROP INDEX IF EXISTS publishers_did_idx;
DROP INDEX IF EXISTS records_indexed_at_idx;
