-- 0026-goodreads-cache.sql
--
-- The Goodreads page cache, moved out of process memory.
--
-- Goodreads answers a successful page with `cache-control: public,
-- max-age=86400`, and the worker used to honour that in a bounded LRU inside
-- the process. That copy was invisible to every other process and to the next
-- restart, so the politeness gate and the WAF were paid for the same pages
-- again; the row here is shared by every worker the way the Google Books and
-- ISBNdb caches already are (0001).
--
-- Shape mirrors those two tables and is read by `createJsonCache` in
-- providers/http.js, whose allowlist names `goodreads_cache`:
--
--   key         `<url>|<page kind>`, the kind fixing the Accept variant
--   url         the same URL, which is what the request column holds
--   body        `{text, url, status}` of a successful page; only these are
--               cached, never a 404, an empty body or a WAF challenge
--   expires_at  now() + 24 h (Goodreads' max-age), enforced by the reader
--
-- Idempotent like the rest: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS goodreads_cache (
  key text PRIMARY KEY,
  url text NOT NULL,
  body jsonb,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS goodreads_cache_expires_at_idx
  ON goodreads_cache (expires_at);

COMMIT;
