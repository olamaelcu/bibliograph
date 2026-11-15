-- 0016-search-indexes.sql
--
-- Trigram indexes for the four `ILIKE '%…%'` predicates of `searchEditions`.
--
-- The search body matched a title, a description, a contributor name and an
-- identifier value in one `OR` of four subplans. A leading-wildcard pattern
-- cannot use a btree and none of those columns had any other index, so every
-- search read `editions` end to end (127k rows, measured 3947 ms on the edge's
-- own database) with three correlated subplans per row, and the `OR` could not
-- fall back to a `BitmapOr` because two of its branches are `EXISTS`
-- subqueries. The read now asks each of the four as its own candidate set, so
-- each needs an index of its own:
--
--   * `editions.title` and `edition_identifiers.value` are plain columns.
--   * The description index is on `coalesce(description, '')` because that is
--     the expression the query compares — an index on the bare column would
--     never be matched.
--   * `contributors.name` is also the author filter of `searchEditions` and the
--     name branch of the entity search.
--
-- `gin_trgm_ops` serves exactly this shape: `likePattern()` emits `%term%`, and
-- the opclass answers both `LIKE` and `ILIKE`.
--
-- Plain `CREATE INDEX`, not `CONCURRENTLY`: deploy.sh stops the worker before
-- it applies any file, and a build holds `SHARE`, which blocks writers but not
-- readers, so the edge keeps answering while these are built. Staying inside
-- the file's transaction keeps the "one file, one transaction, re-runnable"
-- contract every other migration has — and is what lets the schema check apply
-- the whole set to a scratch database.

BEGIN;

-- Trusted extension since PostgreSQL 13: the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS editions_title_trgm_idx
  ON editions USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS edition_shape_description_trgm_idx
  ON edition_shape USING gin ((coalesce(description, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contributors_name_trgm_idx
  ON contributors USING gin (name gin_trgm_ops);

-- Most identifier values are ISBNs, so a text term matches none of them — but
-- without an index that negative answer costs a sequential scan of every
-- identifier (measured 205 ms of the 455 ms the rewritten search took).
CREATE INDEX IF NOT EXISTS edition_identifiers_value_trgm_idx
  ON edition_identifiers USING gin (value gin_trgm_ops);

COMMIT;
