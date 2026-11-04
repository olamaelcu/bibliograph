-- The follow-graph mirror behind `net.olamaelcu.livtet.biblio.graph.follow`.
--
-- Re-issued as 0021: this table was originally written as `0011_follows.sql`,
-- but that file never made it into `meta/_journal.json`, and the migrator plans
-- from the journal — so it was never executed in any environment. Production
-- therefore had no `follows` table and every `graph.follow` call failed with
-- 42P01, silently, because the platform treats the mirror as best-effort and
-- swallows the error.
--
-- Idempotent so it also lands where the table was created by hand.
CREATE TABLE IF NOT EXISTS follows (
  follower_did text NOT NULL,
  followed_did text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_did, followed_did)
);

CREATE INDEX IF NOT EXISTS follows_followed_did_idx ON follows (followed_did);
