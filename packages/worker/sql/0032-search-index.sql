-- Catalog documents the external search index has not applied yet.
--
-- The index is derived: Postgres stays the source of truth and this table is a
-- queue, not state. `refresh_book_search` already computes the document and
-- skips it when the text did not change, so the same function is the natural
-- place to queue a change; deletes and genres have no vector, so they get
-- their own triggers.
--
-- A row is claimed by reading it, then acknowledged with the exact
-- `changed_at` it was read at. A newer change to the same uri rewrites the row
-- with a newer `changed_at` and therefore survives the ack: the indexer will
-- see it again instead of losing it.

CREATE TABLE IF NOT EXISTS search_dirty (
  uri text PRIMARY KEY,
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  changed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_dirty_changed_at_idx
  ON search_dirty (changed_at);

CREATE OR REPLACE FUNCTION mark_search_dirty(p_uri text, p_op text)
RETURNS void
LANGUAGE sql AS $$
  INSERT INTO search_dirty (uri, op, changed_at)
  VALUES (p_uri, p_op, now())
  ON CONFLICT (uri) DO UPDATE
    SET op = EXCLUDED.op,
        changed_at = EXCLUDED.changed_at;
$$;

-- Same document expression as 0027, plus the queue write. `ROW_COUNT` is 1
-- when the upsert inserted or actually changed the document and 0 when an
-- identical document was skipped, which is exactly "the index is stale".
CREATE OR REPLACE FUNCTION refresh_book_search(p_uri text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  changed_rows integer;
BEGIN
  INSERT INTO book_search (uri, document)
  SELECT e.uri,
         setweight(to_tsvector('english', coalesce(e.title, '') || ' ' || coalesce(e.subtitle, '')), 'A')
      || setweight(to_tsvector('english', coalesce(c.names, '')), 'B')
      || setweight(to_tsvector('english', coalesce(s.description, '')), 'C')
      || setweight(to_tsvector('english', coalesce(i.values, '')), 'D')
    FROM books e
    LEFT JOIN edition_shape s ON s.edition_uri = e.uri
    LEFT JOIN LATERAL (
      SELECT string_agg(c2.name, ' ') AS names
        FROM edition_contributors ec
        JOIN contributors c2 ON c2.id = ec.contributor_id
       WHERE ec.edition_uri = e.uri
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(i2.value, ' ') AS values
        FROM edition_identifiers i2
       WHERE i2.edition_uri = e.uri
    ) i ON true
   WHERE e.uri = p_uri
  ON CONFLICT (uri) DO UPDATE SET document = EXCLUDED.document
  WHERE book_search.document IS DISTINCT FROM EXCLUDED.document;

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows > 0 THEN
    PERFORM mark_search_dirty(p_uri, 'upsert');
  END IF;
END
$$;

-- `book_search` cascades on delete and leaves no row to compare, so a deleted
-- book is queued directly.
CREATE OR REPLACE FUNCTION mark_search_deleted_books() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT uri FROM changed LOOP
    PERFORM mark_search_dirty(r.uri, 'delete');
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS search_dirty_books_delete ON books;
CREATE TRIGGER search_dirty_books_delete AFTER DELETE ON books
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_deleted_books();

-- Genres are not part of the tsvector, so they never reach refresh_book_search.
CREATE OR REPLACE FUNCTION mark_search_dirty_genres() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT edition_uri FROM changed LOOP
    PERFORM mark_search_dirty(r.edition_uri, 'upsert');
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS search_dirty_genres_insert ON edition_genres;
CREATE TRIGGER search_dirty_genres_insert AFTER INSERT ON edition_genres
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_genres();

DROP TRIGGER IF EXISTS search_dirty_genres_delete ON edition_genres;
CREATE TRIGGER search_dirty_genres_delete AFTER DELETE ON edition_genres
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_genres();

-- The document the index stores, computed once and reused by the snapshot and
-- the per-uri rebuild. Hydration happens in Postgres from the returned uris, so
-- only the uri has to survive the round trip; the rest feed the index.
CREATE OR REPLACE VIEW search_document_source AS
SELECT
  e.uri,
  e.title,
  e.subtitle,
  coalesce(c.names, '{}') AS contributors,
  s.description,
  coalesce(g.names, '{}') AS genres,
  -- Both columns moved from `books` to `edition_shape` in 0007; the shape row
  -- is the only source now.
  nullif(s.language, '') AS language,
  CASE
    WHEN coalesce(s.published_date, '') ~ '^[0-9]{4}'
    THEN substr(s.published_date, 1, 4)::integer
  END AS year
FROM books e
LEFT JOIN edition_shape s ON s.edition_uri = e.uri
LEFT JOIN LATERAL (
  SELECT array_agg(c2.name) AS names
    FROM edition_contributors ec
    JOIN contributors c2 ON c2.id = ec.contributor_id
   WHERE ec.edition_uri = e.uri
) c ON true
LEFT JOIN LATERAL (
  SELECT array_agg(g2.name) AS names
    FROM edition_genres eg
    JOIN genres g2 ON g2.id = eg.genre_id
   WHERE eg.edition_uri = e.uri
) g ON true;

-- Keyset page of the whole catalog, for the one-shot build.
CREATE OR REPLACE FUNCTION search_documents(p_after text, p_limit integer DEFAULT 2000)
RETURNS TABLE (
  uri text, title text, subtitle text, contributors text[],
  description text, genres text[], language text, year integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.uri, s.title, s.subtitle, s.contributors, s.description, s.genres, s.language, s.year
    FROM search_document_source s
   WHERE s.uri > p_after
   ORDER BY s.uri
   LIMIT greatest(p_limit, 1);
$$;

-- Current documents for an explicit set of uris, for the incremental drain.
CREATE OR REPLACE FUNCTION search_documents_for(p_uris text[])
RETURNS TABLE (
  uri text, title text, subtitle text, contributors text[],
  description text, genres text[], language text, year integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.uri, s.title, s.subtitle, s.contributors, s.description, s.genres, s.language, s.year
    FROM search_document_source s
   WHERE s.uri = ANY(p_uris);
$$;

-- Read a page of the queue. No lock is taken: a second drainer would duplicate
-- work, not corrupt it (upserts are idempotent, the ack is versioned).
--
-- `changed_at` is returned as text on purpose: node-postgres would hand a
-- `Date` back at millisecond precision, while the column keeps microseconds,
-- and the ack could never match it.
CREATE OR REPLACE FUNCTION claim_search_dirty(p_limit integer DEFAULT 500)
RETURNS TABLE (uri text, op text, changed_at text)
LANGUAGE sql STABLE AS $$
  SELECT d.uri, d.op, d.changed_at::text
    FROM search_dirty d
   ORDER BY d.changed_at
   LIMIT greatest(p_limit, 1);
$$;

-- Drop only the versions that were actually applied; a newer change to the same
-- uri has a different `changed_at` and stays queued.
CREATE OR REPLACE FUNCTION ack_search_dirty(p_uris text[], p_versions text[])
RETURNS integer
LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM search_dirty d
     USING unnest(p_uris, p_versions) AS v(uri, version)
     WHERE d.uri = v.uri AND d.changed_at = v.version::timestamp with time zone
     RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;
