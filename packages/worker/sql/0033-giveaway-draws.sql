-- 0033-giveaway-draws.sql
--
-- One row per concluded giveaway. `net.olamaelcu.livtet.biblio.giveaway.draw` is
-- idempotent by insert: the first call stores the seed and the winners it drew,
-- and every later call answers that row instead of drawing again.
--
-- The entrant list is stored with the draw on purpose. Recomputing the winner set
-- from the index would change it whenever an entrant deletes their record after
-- the draw, and a giveaway whose winners move is worse than one that cannot be
-- replayed. With `entrant_dids` beside `seed`, `drawWinners` reproduces the same
-- list forever.
--
-- Nothing else here: the giveaway and its entries are records in readers' own
-- repos, the activity index is what reads them, and this table holds the one
-- decision that must be durable — who won.
--
-- Additive and idempotent like its neighbours: `CREATE TABLE IF NOT EXISTS`, no
-- drops, no rewrites. Applied by `mise run sql` / the worker's migration step;
-- the edge's draw answers 500 on the insert until it has run, so apply it before
-- deploying the procedure.

BEGIN;

CREATE TABLE IF NOT EXISTS giveaway_draws (
  giveaway     text PRIMARY KEY,
  author_did   text NOT NULL,
  seed         text NOT NULL,
  entrant_dids jsonb NOT NULL,
  winners      jsonb NOT NULL,
  drawn_at     timestamptz NOT NULL
);

COMMIT;
