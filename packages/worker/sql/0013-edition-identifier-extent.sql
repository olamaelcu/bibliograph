-- 0013-edition-identifier-extent.sql
--
-- The identifier's format and its size become one claim.
--
-- `format`, `pages` and `duration_seconds` were independent columns, so a row
-- could claim a paperback and an audio duration at once and the edition shape
-- could publish both. The format decides the unit: audio products carry a
-- duration, print and ebook products carry a page count. `extent` stores that
-- pair (`{"format":"Audiobook","durationSeconds":3600}` or
-- `{"format":"Hardcover","pages":320}`), the three old columns become generated
-- projections of it, and a BEFORE trigger normalises every writer.
--
-- Every file is re-applied on deploy, so the conversion is guarded on the
-- columns still being plain. The view and index are recreated unconditionally
-- because 0007 recreates the previous definitions first on every deploy.

BEGIN;

ALTER TABLE edition_identifier_info ADD COLUMN IF NOT EXISTS extent jsonb;

CREATE OR REPLACE FUNCTION identifier_format_is_audio(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT coalesce(value ~* '(audio|audible|mp3)', false);
$function$;

-- Keep the unit the format uses; an unformatted row keeps both. `{}` becomes
-- NULL so an absent claim is distinguishable from a claim with only a format.
CREATE OR REPLACE FUNCTION normalize_identifier_extent(value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN value IS NULL OR value = '{}'::jsonb THEN NULL
    WHEN NULLIF(btrim(value->>'format'), '') IS NULL THEN value
    WHEN identifier_format_is_audio(value->>'format') THEN value - 'pages'
    ELSE value - 'durationSeconds'
  END;
$function$;

CREATE OR REPLACE FUNCTION normalize_identifier_extent_row()
RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.extent := normalize_identifier_extent(NEW.extent);
  RETURN NEW;
END;
$function$;

-- Generated columns are computed after BEFORE triggers, so this prunes the
-- stored claim before `pages` / `duration_seconds` are projected.
CREATE OR REPLACE TRIGGER normalize_identifier_extent
  BEFORE INSERT OR UPDATE OF extent ON edition_identifier_info
  FOR EACH ROW EXECUTE FUNCTION normalize_identifier_extent_row();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'edition_identifier_info'
       AND column_name = 'pages'
       AND is_generated = 'NEVER'
  ) THEN
    RETURN;
  END IF;

  UPDATE edition_identifier_info
     SET extent = normalize_identifier_extent(jsonb_strip_nulls(jsonb_build_object(
           'format', NULLIF(btrim(format), ''),
           'pages', pages,
           'durationSeconds', duration_seconds
         )))
   WHERE extent IS NULL
     AND (format IS NOT NULL OR pages IS NOT NULL OR duration_seconds IS NOT NULL);

  ALTER TABLE edition_identifier_info RENAME COLUMN format TO format_legacy;
  ALTER TABLE edition_identifier_info RENAME COLUMN pages TO pages_legacy;
  ALTER TABLE edition_identifier_info RENAME COLUMN duration_seconds TO duration_seconds_legacy;

  ALTER TABLE edition_identifier_info
    ADD COLUMN format text
      GENERATED ALWAYS AS (NULLIF(btrim(extent->>'format'), '')) STORED,
    ADD COLUMN pages integer
      GENERATED ALWAYS AS (
        CASE WHEN (extent->>'pages') ~ '^[0-9]{1,10}$' THEN (extent->>'pages')::integer END
      ) VIRTUAL,
    ADD COLUMN duration_seconds integer
      GENERATED ALWAYS AS (
        CASE WHEN (extent->>'durationSeconds') ~ '^[0-9]{1,10}$'
             THEN (extent->>'durationSeconds')::integer END
      ) VIRTUAL;

  -- The published shape changes for editions with mixed-format identifiers,
  -- so republish every edition once. The backfill already queued rows it
  -- touched; this also covers editions whose claims did not change.
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM editions e
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL,
    updated_at = now();
END
$migration$;

-- Always applied: 0007 recreates the previous definition before this file.
CREATE OR REPLACE VIEW edition_identifier_shape AS
WITH unioned AS (
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
       FILTER (WHERE description IS NOT NULL AND btrim(description) <> ''))[1] AS description,
    (array_agg(duration_seconds ORDER BY identifier_shape_rank(issuer), issuer, value)
       FILTER (WHERE duration_seconds IS NOT NULL))[1] AS duration_seconds
  FROM edition_identifier_info
  GROUP BY edition_uri
)
SELECT
  edition_uri,
  format,
  language,
  published_date,
  CASE WHEN identifier_format_is_audio(format) THEN NULL ELSE pages END AS pages,
  description,
  CASE WHEN format IS NULL OR identifier_format_is_audio(format)
       THEN duration_seconds ELSE NULL END AS duration_seconds
FROM unioned;

-- Drop the pre-conversion columns now the view no longer names them. The drop
-- also removes the old shape index, so recreate it on the generated column.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'edition_identifier_info'
       AND column_name = 'format_legacy'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE edition_identifier_info
    DROP COLUMN format_legacy,
    DROP COLUMN pages_legacy,
    DROP COLUMN duration_seconds_legacy;
END
$migration$;

CREATE INDEX IF NOT EXISTS edition_identifier_info_shape_idx
  ON edition_identifier_info (lower(format), lower(language));

COMMIT;
