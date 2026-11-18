-- 0023-shape-refresh-statements.sql
--
-- The shape refresh becomes statement-level, and a refresh that computes the
-- same row now writes nothing.
--
-- 0015 installed two `AFTER ... FOR EACH ROW` triggers that call
-- `refresh_edition_shape(edition_uri)` / `refresh_edition_publishers(edition_uri)`
-- per claim row. Each call re-aggregates *every* claim row of that edition, so a
-- candidate written as N claim rows recomputed the whole edition N times, each
-- aggregation reading N rows: O(N²) work for one ingest, plus an
-- `ON CONFLICT ... DO UPDATE` (and a `DELETE ... WHERE NOT EXISTS`) that wrote a
-- new row version even when the aggregate was byte-identical.
--
-- This file replaces both row triggers with statement-level triggers: one
-- trigger per event (`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`), each
-- reading a transition table and calling the same refresh function once per
-- *distinct* edition in that statement. N claim rows in one statement now cost
-- one aggregation, not N.
--
-- `AFTER UPDATE` uses two transition tables. `OLD TABLE` is needed because a
-- claim re-keyed onto another edition changes two shapes, and 0015 refreshed the
-- one it left before the one it joined; without it a re-key would leave a stale
-- `edition_shape`/`edition_publisher_list` row behind. Postgres allows both
-- `OLD TABLE` and `NEW TABLE` on an `AFTER UPDATE ... FOR EACH STATEMENT`
-- trigger (only INSERT/DELETE are limited to one side), so the trigger is
-- `REFERENCING OLD TABLE AS old_changed NEW TABLE AS changed` — every trigger
-- here names its new rows `changed`, which is what lets one function serve all
-- three.
--
-- The no-op guard lives in the aggregate functions themselves: the upsert gains
-- `ON CONFLICT ... DO UPDATE ... WHERE <stored row> IS DISTINCT FROM <computed
-- row>`, so a conflict that computes an identical row updates zero rows and
-- writes no new tuple version. Everything else about the aggregation — column
-- order, `identifier_shape_rank` ordering, the audio projection (0013), the
-- `updated_at` stamp on a real change, and the delete when an edition loses its
-- last claim — is 0015's, unchanged.
--
-- This file is re-applied on every deploy, after 0015 has re-created its row
-- triggers and row functions: it drops those triggers first, so a replay of
-- 0015 followed by this file converges on the statement-level pair. The row
-- functions are dropped with them; the statement functions below are the only
-- callers left.

BEGIN;

-- ---------------------------------------------------------------------------
-- Drop the per-row triggers and functions 0015 created
-- ---------------------------------------------------------------------------

-- Triggers first: the functions cannot be dropped while a trigger depends on
-- them.
DROP TRIGGER IF EXISTS refresh_edition_shape ON edition_identifier_info;
DROP TRIGGER IF EXISTS refresh_edition_publishers ON edition_identifier_publishers;

DROP FUNCTION IF EXISTS refresh_edition_shape_row();
DROP FUNCTION IF EXISTS refresh_edition_publishers_row();

-- ---------------------------------------------------------------------------
-- Edition shape
--
-- Same aggregation as 0015: the best-ranked identifier's claim wins, the audio
-- projection is applied on read-out, and an edition that loses its last claim
-- still loses its row. Only the write is guarded — a refresh that computes the
-- stored row updates nothing, so an unchanged re-ingest does not churn the
-- table.
-- ---------------------------------------------------------------------------

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
    updated_at = now()
  -- Row comparison is null-safe, so a NULL claim column compares equal to a
  -- NULL stored column and the guard fires exactly on a value change.
  WHERE (edition_shape.format,
         edition_shape.language,
         edition_shape.published_date,
         edition_shape.pages,
         edition_shape.description,
         edition_shape.duration_seconds)
        IS DISTINCT FROM
        (excluded.format,
         excluded.language,
         excluded.published_date,
         excluded.pages,
         excluded.description,
         excluded.duration_seconds);

  -- No claim left, no row: the view's `GROUP BY` produced none either.
  DELETE FROM edition_shape s
   WHERE s.edition_uri = p_uri
     AND NOT EXISTS (
       SELECT 1 FROM edition_identifier_info i WHERE i.edition_uri = p_uri
     );
END
$function$;

-- ---------------------------------------------------------------------------
-- Ordered publisher list
--
-- Same ordered array as 0015 (identifier rank, then issuer/value/position) with
-- the same no-op guard on the array.
-- ---------------------------------------------------------------------------

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
  ON CONFLICT (edition_uri) DO UPDATE SET publisher_ids = excluded.publisher_ids
  WHERE edition_publisher_list.publisher_ids IS DISTINCT FROM excluded.publisher_ids;

  -- An edition with no credited publisher has no row, which `hydrate()` and
  -- `appview_book` already read as "no publisher".
  DELETE FROM edition_publisher_list l
   WHERE l.edition_uri = p_uri
     AND NOT EXISTS (
       SELECT 1 FROM edition_identifier_publishers ip WHERE ip.edition_uri = p_uri
     );
END
$function$;

-- ---------------------------------------------------------------------------
-- Statement-level drivers
--
-- One function per table, used by all three event triggers on it. Both loops
-- are ordered so the per-edition row locks are taken in the same order for
-- concurrent statements, and re-keyed editions are refreshed old-before-new.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_edition_shape_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_uri text;
BEGIN
  -- A claim moved onto another edition: refresh the edition it left first. An
  -- edition still present in `changed` is refreshed below from its new rows,
  -- which sees the same remaining claims.
  IF TG_OP = 'UPDATE' THEN
    FOR v_uri IN
      SELECT DISTINCT o.edition_uri
        FROM old_changed o
       WHERE NOT EXISTS (
         SELECT 1 FROM changed n WHERE n.edition_uri = o.edition_uri
       )
       ORDER BY 1
    LOOP
      PERFORM refresh_edition_shape(v_uri);
    END LOOP;
  END IF;

  FOR v_uri IN SELECT DISTINCT edition_uri FROM changed ORDER BY 1 LOOP
    PERFORM refresh_edition_shape(v_uri);
  END LOOP;

  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION refresh_edition_publishers_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_uri text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_uri IN
      SELECT DISTINCT o.edition_uri
        FROM old_changed o
       WHERE NOT EXISTS (
         SELECT 1 FROM changed n WHERE n.edition_uri = o.edition_uri
       )
       ORDER BY 1
    LOOP
      PERFORM refresh_edition_publishers(v_uri);
    END LOOP;
  END IF;

  FOR v_uri IN SELECT DISTINCT edition_uri FROM changed ORDER BY 1 LOOP
    PERFORM refresh_edition_publishers(v_uri);
  END LOOP;

  RETURN NULL;
END
$function$;

-- A trigger that names a transition table serves exactly one event, so each
-- event gets its own trigger; all three name their new rows `changed` (the
-- delete trigger's rows are the old ones).

CREATE OR REPLACE TRIGGER refresh_edition_shape_insert
  AFTER INSERT ON edition_identifier_info
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_shape_statement();

CREATE OR REPLACE TRIGGER refresh_edition_shape_update
  AFTER UPDATE ON edition_identifier_info
  REFERENCING OLD TABLE AS old_changed NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_shape_statement();

CREATE OR REPLACE TRIGGER refresh_edition_shape_delete
  AFTER DELETE ON edition_identifier_info
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_shape_statement();

CREATE OR REPLACE TRIGGER refresh_edition_publishers_insert
  AFTER INSERT ON edition_identifier_publishers
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_publishers_statement();

CREATE OR REPLACE TRIGGER refresh_edition_publishers_update
  AFTER UPDATE ON edition_identifier_publishers
  REFERENCING OLD TABLE AS old_changed NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_publishers_statement();

CREATE OR REPLACE TRIGGER refresh_edition_publishers_delete
  AFTER DELETE ON edition_identifier_publishers
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_edition_publishers_statement();

COMMIT;
