-- 0015-materialize-edition-shape.sql
--
-- The two shape views become trigger-maintained tables.
--
-- `edition_identifier_shape` and `edition_publishers_shape` were aggregates
-- (`GROUP BY edition_uri`, `DISTINCT ON` + `array_agg`), so Postgres had to
-- materialise the aggregate over the whole claim table before it could answer
-- one page. Every edition read joins `EDITION_SHAPE_JOIN`, so every catalog
-- read paid for it: measured on the edge, `searchEditions` averaged 5.56 s in
-- `bibliograph_catalog_query_duration_seconds`, `resolveEditions` 3.61 s, and a
-- two-lookup `getGenresOfBook` 2.90 s of pure queueing behind the five pooled
-- connections those aggregates held.
--
-- The tables carry exactly what the views computed, the views keep their names,
-- columns and order over them, so no consumer changes (`EDITION_SHAPE_JOIN`,
-- `hydrate()`, `identified-formats.ts`, `worker/lib/publish.js`, the
-- `appview_book` definition in 0008) and the join becomes a primary-key
-- lookup. A per-row trigger recomputes one edition from that edition's own
-- claim rows — a handful of rows — instead of the whole table.
--
-- The refresh is an upsert of a single row followed by a delete: one
-- deterministic row lock per edition, which is why it does not add to the
-- deadlocks this database already logs, and why an edition whose last claim is
-- deleted loses its row (the `GROUP BY` used to produce no row for it).
--
-- Every file is re-applied on deploy, so the backfill only runs while its table
-- is empty: after that the triggers own the contents, and a second run is a
-- no-op.

BEGIN;

-- ---------------------------------------------------------------------------
-- Edition shape
--
-- Same seven columns, same order, and the same audio projection the view
-- applied on read-out (0013): the format decides the unit, so an audio product
-- carries a duration and no page count, and an unformatted claim keeps both.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_shape (
  edition_uri text PRIMARY KEY REFERENCES editions (uri) ON DELETE CASCADE,
  format text,
  language text,
  published_date text,
  pages integer,
  description text,
  duration_seconds integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_edition_shape(p_uri text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO edition_shape
         (edition_uri, format, language, published_date, pages, description,
          duration_seconds)
  WITH unioned AS (
    SELECT
      i.edition_uri,
      (array_agg(i.format ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.format IS NOT NULL AND btrim(i.format) <> ''))[1] AS format,
      (array_agg(i.language ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.language IS NOT NULL AND btrim(i.language) <> ''))[1] AS language,
      (array_agg(i.published_date ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.published_date IS NOT NULL AND btrim(i.published_date) <> ''))[1] AS published_date,
      (array_agg(i.pages ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.pages IS NOT NULL))[1] AS pages,
      (array_agg(i.description ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.description IS NOT NULL AND btrim(i.description) <> ''))[1] AS description,
      (array_agg(i.duration_seconds ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.duration_seconds IS NOT NULL))[1] AS duration_seconds
    FROM edition_identifier_info i
    WHERE i.edition_uri = p_uri
    GROUP BY i.edition_uri
  )
  SELECT
    u.edition_uri,
    u.format,
    u.language,
    u.published_date,
    CASE WHEN identifier_format_is_audio(u.format) THEN NULL ELSE u.pages END,
    u.description,
    CASE WHEN u.format IS NULL OR identifier_format_is_audio(u.format)
         THEN u.duration_seconds ELSE NULL END
  FROM unioned u
  ON CONFLICT (edition_uri) DO UPDATE SET
    format = excluded.format,
    language = excluded.language,
    published_date = excluded.published_date,
    pages = excluded.pages,
    description = excluded.description,
    duration_seconds = excluded.duration_seconds,
    updated_at = now();

  -- No claim left, no row: the view's `GROUP BY` produced none either.
  DELETE FROM edition_shape s
   WHERE s.edition_uri = p_uri
     AND NOT EXISTS (
       SELECT 1 FROM edition_identifier_info i WHERE i.edition_uri = p_uri
     );
END
$function$;

CREATE OR REPLACE FUNCTION refresh_edition_shape_row()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_edition_shape(OLD.edition_uri);
    RETURN NULL;
  END IF;

  -- A claim re-keyed onto another edition changes two shapes; refresh the one
  -- it left before the one it joined.
  IF TG_OP = 'UPDATE' AND NEW.edition_uri IS DISTINCT FROM OLD.edition_uri THEN
    PERFORM refresh_edition_shape(OLD.edition_uri);
  END IF;

  PERFORM refresh_edition_shape(NEW.edition_uri);
  RETURN NULL;
END
$function$;

CREATE OR REPLACE TRIGGER refresh_edition_shape
  AFTER INSERT OR UPDATE OR DELETE ON edition_identifier_info
  FOR EACH ROW EXECUTE FUNCTION refresh_edition_shape_row();

-- ---------------------------------------------------------------------------
-- Ordered publisher list
--
-- One ordered publisher-id array per edition: the best-ranked identifier first
-- (isbn13 → isbn10 → asin → any other issuer), then that identifier's position.
-- A publisher credited by several identifiers keeps its first occurrence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_publisher_list (
  edition_uri text PRIMARY KEY REFERENCES editions (uri) ON DELETE CASCADE,
  publisher_ids bigint[] NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE FUNCTION refresh_edition_publishers(p_uri text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO edition_publisher_list (edition_uri, publisher_ids)
  SELECT p_uri,
         array_agg(f.publisher_id ORDER BY f.rk, f.issuer, f.value, f.position)
    FROM (
      SELECT DISTINCT ON (ip.publisher_id)
             ip.publisher_id,
             identifier_shape_rank(ip.issuer) AS rk,
             ip.issuer,
             ip.value,
             ip.position
        FROM edition_identifier_publishers ip
       WHERE ip.edition_uri = p_uri
       ORDER BY ip.publisher_id,
                identifier_shape_rank(ip.issuer),
                ip.issuer,
                ip.value,
                ip.position
    ) f
   HAVING count(*) > 0
  ON CONFLICT (edition_uri) DO UPDATE SET publisher_ids = excluded.publisher_ids;

  -- An edition with no credited publisher has no row, which `hydrate()` and
  -- `appview_book` already read as "no publisher".
  DELETE FROM edition_publisher_list l
   WHERE l.edition_uri = p_uri
     AND NOT EXISTS (
       SELECT 1 FROM edition_identifier_publishers ip WHERE ip.edition_uri = p_uri
     );
END
$function$;

CREATE OR REPLACE FUNCTION refresh_edition_publishers_row()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_edition_publishers(OLD.edition_uri);
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.edition_uri IS DISTINCT FROM OLD.edition_uri THEN
    PERFORM refresh_edition_publishers(OLD.edition_uri);
  END IF;

  PERFORM refresh_edition_publishers(NEW.edition_uri);
  RETURN NULL;
END
$function$;

CREATE OR REPLACE TRIGGER refresh_edition_publishers
  AFTER INSERT OR UPDATE OR DELETE ON edition_identifier_publishers
  FOR EACH ROW EXECUTE FUNCTION refresh_edition_publishers_row();

-- ---------------------------------------------------------------------------
-- Backfill
--
-- The same aggregation restricted to nothing, run once over the existing claim
-- rows. Only while the table is empty: afterwards the triggers are the only
-- writer, so a re-applied file inserts nothing.
-- ---------------------------------------------------------------------------

DO $backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM edition_shape) THEN
    RETURN;
  END IF;

  INSERT INTO edition_shape
         (edition_uri, format, language, published_date, pages, description,
          duration_seconds)
  WITH unioned AS (
    SELECT
      i.edition_uri,
      (array_agg(i.format ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.format IS NOT NULL AND btrim(i.format) <> ''))[1] AS format,
      (array_agg(i.language ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.language IS NOT NULL AND btrim(i.language) <> ''))[1] AS language,
      (array_agg(i.published_date ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.published_date IS NOT NULL AND btrim(i.published_date) <> ''))[1] AS published_date,
      (array_agg(i.pages ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.pages IS NOT NULL))[1] AS pages,
      (array_agg(i.description ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.description IS NOT NULL AND btrim(i.description) <> ''))[1] AS description,
      (array_agg(i.duration_seconds ORDER BY identifier_shape_rank(i.issuer), i.issuer, i.value)
         FILTER (WHERE i.duration_seconds IS NOT NULL))[1] AS duration_seconds
    FROM edition_identifier_info i
    GROUP BY i.edition_uri
  )
  SELECT
    u.edition_uri,
    u.format,
    u.language,
    u.published_date,
    CASE WHEN identifier_format_is_audio(u.format) THEN NULL ELSE u.pages END,
    u.description,
    CASE WHEN u.format IS NULL OR identifier_format_is_audio(u.format)
         THEN u.duration_seconds ELSE NULL END
  FROM unioned u;
END
$backfill$;

DO $backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM edition_publisher_list) THEN
    RETURN;
  END IF;

  INSERT INTO edition_publisher_list (edition_uri, publisher_ids)
  SELECT edition_uri,
         array_agg(publisher_id ORDER BY rk, issuer, value, position)
    FROM (
      SELECT DISTINCT ON (ip.edition_uri, ip.publisher_id)
             ip.edition_uri,
             ip.publisher_id,
             identifier_shape_rank(ip.issuer) AS rk,
             ip.issuer,
             ip.value,
             ip.position
        FROM edition_identifier_publishers ip
       ORDER BY ip.edition_uri,
                ip.publisher_id,
                identifier_shape_rank(ip.issuer),
                ip.issuer,
                ip.value,
                ip.position
    ) first_credit
   GROUP BY edition_uri;
END
$backfill$;

-- `editionLanguageClause` compares the primary subtag of the claim
-- (`split_part(lower(s.language), '-', 1)`), so the filter is indexed too.
CREATE INDEX IF NOT EXISTS edition_shape_language_idx
  ON edition_shape (split_part(lower(language), '-', 1));

-- ---------------------------------------------------------------------------
-- The views keep their identity: same name, same columns, same order.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW edition_identifier_shape AS
SELECT edition_uri, format, language, published_date, pages, description,
       duration_seconds
FROM edition_shape;

CREATE OR REPLACE VIEW edition_publishers_shape AS
SELECT edition_uri, publisher_ids
FROM edition_publisher_list;

COMMIT;
