CREATE TABLE IF NOT EXISTS follows (
  follower_did text NOT NULL,
  followed_did text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_did, followed_did)
);

CREATE INDEX IF NOT EXISTS follows_followed_did_idx ON follows (followed_did);
