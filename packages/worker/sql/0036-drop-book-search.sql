-- The catalog search index moved to `bibliograph-search` (a Tantivy service);
-- the tsvector table was still maintained on every write and its 549 MB of
-- heap + GIN competed with the page cache that hydration needs on a host whose
-- working set already exceeds RAM.
--
-- The change queue (`search_dirty`, 0035) is now maintained by its own
-- triggers instead of `refresh_book_search`'s "did the document change" check.
-- That check is gone with the document: a write that touches an edition now
-- queues it whether or not a field the index carries changed. The drain is
-- idempotent and coalesces per uri, so the cost is a few extra rebuilds, not
-- correctness.

DROP TRIGGER IF EXISTS book_search_books_insert ON books;
DROP TRIGGER IF EXISTS book_search_books_update ON books;
DROP TRIGGER IF EXISTS book_search_books_delete ON books;
DROP TRIGGER IF EXISTS book_search_edition_contributors_insert ON edition_contributors;
DROP TRIGGER IF EXISTS book_search_edition_contributors_update ON edition_contributors;
DROP TRIGGER IF EXISTS book_search_edition_contributors_delete ON edition_contributors;
DROP TRIGGER IF EXISTS book_search_edition_identifiers_insert ON edition_identifiers;
DROP TRIGGER IF EXISTS book_search_edition_identifiers_update ON edition_identifiers;
DROP TRIGGER IF EXISTS book_search_edition_identifiers_delete ON edition_identifiers;
DROP TRIGGER IF EXISTS book_search_edition_shape_insert ON edition_shape;
DROP TRIGGER IF EXISTS book_search_edition_shape_update ON edition_shape;
DROP TRIGGER IF EXISTS book_search_edition_shape_delete ON edition_shape;

DROP FUNCTION IF EXISTS refresh_book_search_books();
DROP FUNCTION IF EXISTS refresh_book_search_children();
DROP FUNCTION IF EXISTS refresh_book_search(text);

DROP TABLE IF EXISTS book_search;

-- `books` keys the changed rows by `uri`, the child tables by `edition_uri`.
CREATE OR REPLACE FUNCTION mark_search_dirty_books() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT uri FROM changed LOOP
    PERFORM mark_search_dirty(r.uri, 'upsert');
  END LOOP;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION mark_search_dirty_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT edition_uri FROM changed LOOP
    PERFORM mark_search_dirty(r.edition_uri, 'upsert');
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS search_dirty_books_insert ON books;
DROP TRIGGER IF EXISTS search_dirty_books_update ON books;
CREATE TRIGGER search_dirty_books_insert AFTER INSERT ON books
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_books();
CREATE TRIGGER search_dirty_books_update AFTER UPDATE ON books
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_books();

DROP TRIGGER IF EXISTS search_dirty_edition_contributors_insert ON edition_contributors;
DROP TRIGGER IF EXISTS search_dirty_edition_contributors_update ON edition_contributors;
CREATE TRIGGER search_dirty_edition_contributors_insert AFTER INSERT ON edition_contributors
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();
CREATE TRIGGER search_dirty_edition_contributors_update AFTER UPDATE ON edition_contributors
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();

DROP TRIGGER IF EXISTS search_dirty_edition_identifiers_insert ON edition_identifiers;
DROP TRIGGER IF EXISTS search_dirty_edition_identifiers_update ON edition_identifiers;
CREATE TRIGGER search_dirty_edition_identifiers_insert AFTER INSERT ON edition_identifiers
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();
CREATE TRIGGER search_dirty_edition_identifiers_update AFTER UPDATE ON edition_identifiers
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();

DROP TRIGGER IF EXISTS search_dirty_edition_shape_insert ON edition_shape;
DROP TRIGGER IF EXISTS search_dirty_edition_shape_update ON edition_shape;
CREATE TRIGGER search_dirty_edition_shape_insert AFTER INSERT ON edition_shape
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();
CREATE TRIGGER search_dirty_edition_shape_update AFTER UPDATE ON edition_shape
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION mark_search_dirty_children();
