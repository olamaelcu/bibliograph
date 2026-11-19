-- `pds_outbox` is a queue: rows are claimed and deleted continuously, so it
-- churns dead tuples far faster than any other table. On production it carried
-- 136k live and 33k dead rows and had been autovacuumed **6259 times**, each
-- run reading and writing (WALSync) for tens of seconds on a two-vCPU host
-- while the feed and the catalog writes waited behind it.
--
-- `fillfactor=70` leaves room for the claim/delete cycle to stay on the same
-- page (HOT updates, no new page per claim), and the per-table autovacuum
-- settings let it run often, cheaply, instead of rarely and expensively. The
-- table is small (245 MB); the cost here is a one-time rewrite to apply the
-- fillfactor, not ongoing work.
--
-- `VACUUM` is deliberately not part of this file: migrations are replayed on
-- every deploy and a full vacuum belongs in the deploy's own step, not in a
-- schema file that has to stay re-runnable and instant.
ALTER TABLE pds_outbox SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_vacuum_cost_limit = 1000
);
