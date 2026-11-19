-- 0033-giveaway-terms.sql
--
-- The closing date the AppView verified, and the record revision that stated it.
--
-- A giveaway lives in the author's repo, so its `closesAt` is editable by the
-- account that owns it. `giveaway_terms.closes_at` is the authoritative end: the
-- first time the AppView sees a giveaway it records the term and the CID that
-- stated it, and every later sighting must match. A record that disagrees is
-- refused (`409 TermMismatch`, naming both dates) so the caller can rewrite it
-- back to the term recorded here. The one way the stored term moves forwards is
-- `giveaway.extend`, authenticated by the author's own PDS — which is why a
-- rewrite done by hand can never take time back, and can never add it either
-- without going through that call.
--
-- `cid` is the audit trail rather than the invariant: a rewrite that leaves the
-- term alone (`rulesText`, a typo in the title) is legitimate, and the row
-- follows it on the next verification.

BEGIN;

CREATE TABLE IF NOT EXISTS giveaway_terms (
  giveaway     text PRIMARY KEY,
  author_did   text NOT NULL,
  closes_at    timestamptz NOT NULL,
  cid          text NOT NULL,
  observed_at  timestamptz NOT NULL
);

COMMIT;
