-- 0027-book-search-vector.sql
--
-- `searchEditions` matched free text with four `ILIKE '%term%'` branches — title,
-- description, contributor name, identifier value — each a trigram GIN scan,
-- unioned and folded with a hash aggregate. Measured on a 234k-book catalog:
-- 454 ms for a page and 1 075 ms for the count of one term, most of it in the
-- description trigram over `edition_shape`.
--
-- One tsvector per book replaces those four branches: the search is a single
-- GIN scan over `document` and `ts_rank_cd` orders the matches, so a term costs
-- one index scan instead of four plus an aggregate. Measured after the change
-- on the same catalog: 25 ms for a page and 8.6 ms for the count. The trigram
-- indexes stay for the `title` / `author` / `identifiers` hint branches, which
-- keep their exact-bucket ranking.
--
-- `'english'` is deliberate on both sides: the document and the query must use
-- the same configuration or a stemmed query will not match a stemmed document,
-- and the English stopword list keeps a term like "the" from producing a lexeme
-- that every row carries. The consequence is word matching with stemming
-- ("Dunes" finds "Dune") rather than substring matching; the trigram branches
-- still cover substrings for the title and author hints.
--
-- The document is maintained by statement-level triggers on the four tables
-- that contribute lexemes. Each trigger visits every affected book once per
-- statement, not once per row, and `refresh_book_search` skips an unchanged
-- document.

BEGIN;

CREATE TABLE IF NOT EXISTS book_search (
  uri text PRIMARY KEY REFERENCES books (uri) ON DELETE CASCADE,
  document tsvector NOT NULL
);

CREATE INDEX IF NOT EXISTS book_search_document_idx
  ON book_search USING gin (document);

CREATE OR REPLACE FUNCTION refresh_book_search(p_uri text) RETURNS void
LANGUAGE plpgsql AS $$
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
END
$$;

-- One function per row shape: `books` keys the affected rows by `uri`, the
-- three child tables by `edition_uri`. The transition table is always `changed`.
CREATE OR REPLACE FUNCTION refresh_book_search_books() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT uri FROM changed LOOP
    PERFORM refresh_book_search(r.uri);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION refresh_book_search_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT edition_uri FROM changed LOOP
    PERFORM refresh_book_search(r.edition_uri);
  END LOOP;
  RETURN NULL;
END
$$;

-- `books`: insert and delete carry the key; an update's new key is the one to
-- refresh (the primary key is the record's at-uri and does not change in place).
DROP TRIGGER IF EXISTS book_search_books_insert ON books;
DROP TRIGGER IF EXISTS book_search_books_update ON books;
DROP TRIGGER IF EXISTS book_search_books_delete ON books;
CREATE TRIGGER book_search_books_insert AFTER INSERT ON books
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_books();
CREATE TRIGGER book_search_books_update AFTER UPDATE ON books
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_books();
CREATE TRIGGER book_search_books_delete AFTER DELETE ON books
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_books();

-- The three child tables contribute lexemes (contributor names, identifier
-- values, the shape claim's description); their key is `edition_uri`.
DO $triggers$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['edition_contributors', 'edition_identifiers', 'edition_shape']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS book_search_%1$s_insert ON %1$s', target);
    EXECUTE format('DROP TRIGGER IF EXISTS book_search_%1$s_update ON %1$s', target);
    EXECUTE format('DROP TRIGGER IF EXISTS book_search_%1$s_delete ON %1$s', target);
    EXECUTE format(
      'CREATE TRIGGER book_search_%1$s_insert AFTER INSERT ON %1$s
         REFERENCING NEW TABLE AS changed
         FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_children()', target);
    EXECUTE format(
      'CREATE TRIGGER book_search_%1$s_update AFTER UPDATE ON %1$s
         REFERENCING NEW TABLE AS changed
         FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_children()', target);
    EXECUTE format(
      'CREATE TRIGGER book_search_%1$s_delete AFTER DELETE ON %1$s
         REFERENCING OLD TABLE AS changed
         FOR EACH STATEMENT EXECUTE FUNCTION refresh_book_search_children()', target);
  END LOOP;
END
$triggers$;

-- Backfill: the same document expression, set-based, and only for books that
-- have no document yet. The first deploy pays the projection (2m34s for 234k
-- books here); every later replay is an anti-join that inserts nothing. An
-- upsert that compared documents instead would recompute every row on every
-- deploy. The child aggregates are grouped once and hash-joined; a correlated
-- `LATERAL` per book made this a nested loop of two index lookups per row,
-- which did not finish in four minutes.
INSERT INTO book_search (uri, document)
SELECT e.uri,
       setweight(to_tsvector('english', coalesce(e.title, '') || ' ' || coalesce(e.subtitle, '')), 'A')
    || setweight(to_tsvector('english', coalesce(c.names, '')), 'B')
    || setweight(to_tsvector('english', coalesce(s.description, '')), 'C')
    || setweight(to_tsvector('english', coalesce(i.values, '')), 'D')
  FROM books e
  LEFT JOIN edition_shape s ON s.edition_uri = e.uri
  LEFT JOIN (
    SELECT ec.edition_uri, string_agg(c2.name, ' ') AS names
      FROM edition_contributors ec
      JOIN contributors c2 ON c2.id = ec.contributor_id
     GROUP BY ec.edition_uri
  ) c ON c.edition_uri = e.uri
  LEFT JOIN (
    SELECT i2.edition_uri, string_agg(i2.value, ' ') AS values
      FROM edition_identifiers i2
     GROUP BY i2.edition_uri
  ) i ON i.edition_uri = e.uri
 WHERE NOT EXISTS (SELECT 1 FROM book_search bs WHERE bs.uri = e.uri)
ON CONFLICT (uri) DO NOTHING;

COMMIT;
