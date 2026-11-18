-- 0030-compact-goodreads-cache.sql
--
-- `0026` moved the Goodreads page cache out of process memory as
-- `{text, url, status}` — the whole HTML page, ~170 KB each. 1,921 rows came to
-- 331 MB, the largest relation in the database, for pages whose only consumer is
-- the parser in `providers/goodreads.js`. That module now caches the parsed
-- candidates and genres instead, which is kilobytes per page.
--
-- This removes the rows in the old shape. The cache is disposable — 24 h TTL,
-- refetched on demand, never authoritative — so deleting it is safe.
--
-- No `VACUUM FULL` here: the vitest harness applies every file as one
-- `client.query(text)`, which is an implicit transaction, and `VACUUM` cannot
-- run inside one (25001). The delete alone stops the growth and lets autovacuum
-- reuse the space; the file returns to the filesystem with a one-time
--     VACUUM (FULL, ANALYZE) goodreads_cache;
-- run by the operator after the deploy (needs the table owner, so the worker's
-- role can do it, but not from inside a migration).
--
-- A replay deletes nothing: rows written since carry `candidates`, not `text`.

BEGIN;

DELETE FROM goodreads_cache WHERE body ? 'text';

COMMIT;
