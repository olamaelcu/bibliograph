-- Restore the follow-graph table.
--
-- `follows` was created by 0021 and dropped by 0022 because nothing read it: it
-- was written only by `net.olamaelcu.livtet.biblio.graph.follow`, a procedure
-- whose DDL never entered `meta/_journal.json` and therefore never ran, so the
-- table was never populated anywhere.
--
-- It is back now as a read index over records that already live in users' own
-- PDSes (`net.olamaelcu.livtet.biblio.follow`, key type `tid`, `subject` = the
-- followed actor's at-uri). TAP mirrors those records into `records`, so this
-- table is derived state: it can be rebuilt from the mirror at any time, and
-- `tapRecordUpsertTask` / `tapRecordDeleteTask` keep it in step.
--
-- Idempotent, so it also lands where 0021 was applied by hand before the
-- journal knew about it.
CREATE TABLE IF NOT EXISTS follows (
  follower_did text NOT NULL,
  followed_did text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_did, followed_did)
);

-- `followed_did` answers "who follows me"; the primary key's leading column
-- answers "who do I follow".
CREATE INDEX IF NOT EXISTS follows_followed_did_idx ON follows (followed_did);

-- One-time backfill from the TAP mirror. `records.did` is the follower (the
-- record's repo), and `subject` names the followed actor as an at-uri, so the
-- DID is its third path segment. Rows whose subject is not a DID are skipped:
-- a follow of something other than an identity names no follower edge.
--
-- ON CONFLICT keeps a re-run (or an environment that already has rows) harmless.
INSERT INTO follows (follower_did, followed_did, created_at)
SELECT
  r.did,
  split_part(r.value ->> 'subject', '/', 3),
  COALESCE((r.value ->> 'createdAt')::timestamptz, r.created_at)
FROM records r
WHERE r.collection = 'net.olamaelcu.livtet.biblio.follow'
  AND split_part(r.value ->> 'subject', '/', 3) LIKE 'did:%'
ON CONFLICT (follower_did, followed_did) DO NOTHING;
