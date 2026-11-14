-- 0007-edition-identifier-info.sql
--
-- Edition shape claims move from the edition to its identifiers.
--
-- An edition can carry several identifiers (eight ISBNs after a provider import
-- and a merge), and each provider record makes its own claim about the book's
-- language, publication date, format, pages and description. Holding one merged
-- winner on `editions` destroyed the per-identifier evidence, so the five claims
-- move onto `edition_identifier_info` (one row per `edition_identifiers` pair)
-- and the edition's public shape becomes a deterministic union over its
-- identifiers (`edition_identifier_shape`): `isbn13` → `isbn10` → `asin` → any
-- other issuer, ties by `(issuer, value)` ascending.
--
-- This file deliberately departs from 0001's "never drops a column" invariant:
-- the five columns leave `editions`. The drop is guarded, so re-applying the
-- file is a no-op, and the backfill runs before it, so no value is lost.
--
-- The publisher is not a claim: 0008 replaces `edition_publishers` with a link
-- table keyed by the same identifier triple, so nothing about it lives here.

BEGIN;

-- ---------------------------------------------------------------------------
-- Claim rows
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION identifier_shape_rank(issuer text)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE issuer WHEN 'isbn13' THEN 0 WHEN 'isbn10' THEN 1 WHEN 'asin' THEN 2 ELSE 3 END;
$function$;

CREATE TABLE IF NOT EXISTS edition_identifier_info (
  edition_uri text NOT NULL,
  issuer text NOT NULL,
  value text NOT NULL,
  format text,
  language text,
  published_date text,
  pages integer,
  description text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_uri, issuer, value),
  FOREIGN KEY (edition_uri, issuer, value)
    REFERENCES edition_identifiers (edition_uri, issuer, value)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS edition_identifier_info_shape_idx
  ON edition_identifier_info (lower(format), lower(language));

CREATE OR REPLACE VIEW edition_identifier_shape AS
SELECT
  edition_uri,
  (array_agg(format ORDER BY identifier_shape_rank(issuer), issuer, value)
     FILTER (WHERE format IS NOT NULL AND btrim(format) <> ''))[1] AS format,
  (array_agg(language ORDER BY identifier_shape_rank(issuer), issuer, value)
     FILTER (WHERE language IS NOT NULL AND btrim(language) <> ''))[1] AS language,
  (array_agg(published_date ORDER BY identifier_shape_rank(issuer), issuer, value)
     FILTER (WHERE published_date IS NOT NULL AND btrim(published_date) <> ''))[1] AS published_date,
  (array_agg(pages ORDER BY identifier_shape_rank(issuer), issuer, value)
     FILTER (WHERE pages IS NOT NULL))[1] AS pages,
  (array_agg(description ORDER BY identifier_shape_rank(issuer), issuer, value)
     FILTER (WHERE description IS NOT NULL AND btrim(description) <> ''))[1] AS description
FROM edition_identifier_info
GROUP BY edition_uri;

-- The five claims are now part of the published record, so a claim change must
-- queue the edition. `pds_enqueue_edition_child()` (0001) keys off
-- `edition_uri`, which this table has.
CREATE OR REPLACE TRIGGER pds_enqueue_identifier_info
  AFTER INSERT OR UPDATE OR DELETE ON edition_identifier_info
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();

-- ---------------------------------------------------------------------------
-- Read models: the edition's shape is the identifier union
--
-- Same columns and order as 0004 — only the five shape expressions change, and
-- they now come from the shape view instead of `editions`.
--
-- 0008 moved the publisher links onto the identifier and dropped
-- `edition_publishers`, so this definition only applies while that table still
-- exists; 0008 owns the view from then on.
-- ---------------------------------------------------------------------------

DO $views$
DECLARE
  legacy boolean := to_regclass(current_schema() || '.edition_publishers') IS NOT NULL;
BEGIN
  IF NOT legacy THEN
    RETURN;
  END IF;

  EXECUTE $book$CREATE OR REPLACE VIEW appview_book AS
SELECT
  e.uri,
  e.rkey,
  e.title,
  e.subtitle,
  s.language,
  s.published_date,
  s.format,
  s.pages,
  e.duration_seconds,
  e.chapters,
  e.series,
  e.book_edition,
  s.description,
  e.cover_url,
  e.created_at,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'position', ec.position,
               'name', c.name,
               'role', ec.role,
               'identifiers', c.identifiers,
               'ref', COALESCE(ec.ref, c.at_uri)
             )) ORDER BY ec.position
           )
      FROM edition_contributors ec
      JOIN contributors c ON c.id = ec.contributor_id
     WHERE ec.edition_uri = e.uri
  ), '[]'::jsonb) AS contributors,
  (
    SELECT jsonb_strip_nulls(jsonb_build_object(
             'name', p.name,
             'identifiers', p.identifiers,
             'ref', p.at_uri
           ))
      FROM edition_publishers ep
      JOIN publishers p ON p.id = ep.publisher_id
     WHERE ep.edition_uri = e.uri
     ORDER BY ep.position
     LIMIT 1
  ) AS publisher,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'name', p.name,
               'identifiers', p.identifiers,
               'ref', p.at_uri
             ))
             ORDER BY ep.position
           )
      FROM edition_publishers ep
      JOIN publishers p ON p.id = ep.publisher_id
     WHERE ep.edition_uri = e.uri
  ), '[]'::jsonb) AS publishers,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object('issuer', i.issuer, 'value', i.value)
             ORDER BY i.issuer, i.value
           )
      FROM edition_identifiers i
     WHERE i.edition_uri = e.uri
  ), '[]'::jsonb) AS identifiers
FROM editions e
LEFT JOIN edition_identifier_shape s ON s.edition_uri = e.uri$book$;
END
$views$;

-- ---------------------------------------------------------------------------
-- Backfill and drop
--
-- Every identifier of an edition inherits the edition's current values, so the
-- rank-based union reproduces today's shape exactly. Guarded on the column: a
-- second run returns immediately.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'editions'
       AND column_name = 'format'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO edition_identifier_info
         (edition_uri, issuer, value, format, language, published_date, pages, description)
  SELECT i.edition_uri, i.issuer, i.value,
         e.format, e.language, e.published_date, e.pages, e.description
    FROM edition_identifiers i
    JOIN editions e ON e.uri = i.edition_uri
   WHERE e.format IS NOT NULL OR e.language IS NOT NULL
      OR e.published_date IS NOT NULL OR e.pages IS NOT NULL
      OR e.description IS NOT NULL
  ON CONFLICT (edition_uri, issuer, value) DO NOTHING;

  ALTER TABLE editions
    DROP COLUMN format,
    DROP COLUMN language,
    DROP COLUMN published_date,
    DROP COLUMN pages,
    DROP COLUMN description;
END
$migration$;

COMMIT;
