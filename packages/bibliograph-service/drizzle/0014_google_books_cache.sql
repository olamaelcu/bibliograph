-- Google Books response cache.
--
-- The GB quota is charged per request against one API key shared by the web and
-- worker processes, and the same questions get asked over and over: the same
-- search box query, the same shelf hydration of the same volume id, and — far
-- more than either — the same `q=isbn:` lookup for every edition an ISBN
-- backfill touches. Caching in Postgres rather than in a process Map makes one
-- answer serve all processes and survive deploys.
--
--   key         sha256 of the normalized request URL (API key stripped, params sorted)
--   url         that normalized URL, for audit — never the credential
--   body        the verbatim upstream JSON; NULL means "upstream has no such
--               volume", which is cached too: the quota is spent by asking, not
--               by the answer, so remembering a 404 saves as much as a hit
--   fetched_at  when it was stored
--   expires_at  fetched_at + 24h, for hits and misses alike
--
-- Expired rows are swept in bounded batches by the cache writer, so the index on
-- expires_at is what keeps that sweep cheap.
CREATE TABLE IF NOT EXISTS google_books_cache (
  key text PRIMARY KEY,
  url text NOT NULL,
  body jsonb,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS google_books_cache_expires_at_idx
  ON google_books_cache (expires_at);
