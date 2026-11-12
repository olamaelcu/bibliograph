-- 0004-entity-records.sql
--
-- Contributor and publisher records.
--
-- Editions are no longer the only published record type: `contributors` and
-- `publishers` gain a stable at-URI and are queued to `pds_outbox` under
-- `net.olamaelcu.livtet.biblio.contributor` / `.publisher`. The edition builders
-- then link their inline objects to those records:
--
--   defs#contributor.ref = COALESCE(ec.ref, c.at_uri)   (per-edge override wins)
--   defs#publisher.ref   = p.at_uri
--
-- Additive and idempotent, like 0001: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX
-- IF NOT EXISTS`, `CREATE OR REPLACE` for functions/triggers/views. It never
-- drops, truncates or rewrites a row, and it does NOT mint URIs for existing
-- rows: `at_uri` stays NULL until the `entities.prepare` worker task runs with
-- the configured publisher authority. A trigger skips a NULL `at_uri`, so this
-- file alone queues nothing.
--
-- `CREATE OR REPLACE VIEW` can change expressions but not the column list, so
-- both views keep exactly the columns (and order) they have in 0001.

BEGIN;

-- ---------------------------------------------------------------------------
-- Entity metadata
-- ---------------------------------------------------------------------------

ALTER TABLE contributors ADD COLUMN IF NOT EXISTS at_uri        text;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS name_inverted text;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS description   text;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS image_url     text;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS born          text;
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS died          text;

ALTER TABLE publishers   ADD COLUMN IF NOT EXISTS at_uri      text;
ALTER TABLE publishers   ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE publishers   ADD COLUMN IF NOT EXISTS image_url   text;
ALTER TABLE publishers   ADD COLUMN IF NOT EXISTS started     text;
ALTER TABLE publishers   ADD COLUMN IF NOT EXISTS ended       text;

-- One record per row, and two rows can never share an address. Partial so the
-- existing (not yet minted) rows do not collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS contributors_at_uri_idx
  ON contributors (at_uri) WHERE at_uri IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS publishers_at_uri_idx
  ON publishers (at_uri) WHERE at_uri IS NOT NULL;

-- Exact identifier containment: `identifiers @> '[{"issuer":…,"value":…}]'`.
-- jsonb_path_ops is smaller than the default operator class and serves `@>`.
CREATE INDEX IF NOT EXISTS contributors_identifiers_gin_idx
  ON contributors USING gin (identifiers jsonb_path_ops);
CREATE INDEX IF NOT EXISTS publishers_identifiers_gin_idx
  ON publishers USING gin (identifiers jsonb_path_ops);

-- Born/died/started/ended are full YYYY-MM-DD dates; the builders validate the
-- calendar. A CHECK is deliberately not added: older deployments may already
-- hold a provider-supplied partial date, and this migration must not fail on
-- existing rows.

-- ---------------------------------------------------------------------------
-- Entity outbox triggers
--
-- One generic function, the collection passed as a trigger argument. `op` is
-- advisory: publish.js chooses create vs update from `pds_cids`, so a row whose
-- URI was minted by a later UPDATE still publishes as a create.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pds_enqueue_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.at_uri IS NULL THEN
      RETURN OLD;
    END IF;
    INSERT INTO pds_outbox (uri, collection, rkey, op)
    VALUES (OLD.at_uri, TG_ARGV[0], split_part(OLD.at_uri, '/', 5), 'delete')
    ON CONFLICT (uri) DO UPDATE SET
      op = 'delete',
      value = NULL,
      updated_at = now();
    RETURN OLD;
  END IF;

  -- Not minted yet: `entities.prepare` mints it and queues the row itself.
  IF NEW.at_uri IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO pds_outbox (uri, collection, rkey, op)
  VALUES (
    NEW.at_uri,
    TG_ARGV[0],
    split_part(NEW.at_uri, '/', 5),
    CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END
  )
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE EXCLUDED.op END,
    value = NULL,
    updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER pds_enqueue_contributor_record
  AFTER INSERT OR UPDATE OR DELETE ON contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_entity('net.olamaelcu.livtet.biblio.contributor');

CREATE OR REPLACE TRIGGER pds_enqueue_publisher_record
  AFTER INSERT OR UPDATE OR DELETE ON publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_entity('net.olamaelcu.livtet.biblio.publisher');

-- ---------------------------------------------------------------------------
-- Read models: inline objects now carry the record reference
--
-- Same columns and order as 0001. Only the two jsonb expressions change, so
-- HappyView's `edition_view` (views.lua) picks the ref up with no Lua change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW appview_book AS
SELECT
  e.uri,
  e.rkey,
  e.title,
  e.subtitle,
  e.language,
  e.published_date,
  e.format,
  e.pages,
  e.duration_seconds,
  e.chapters,
  e.series,
  e.book_edition,
  e.description,
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
FROM editions e;

CREATE OR REPLACE VIEW appview_book_lua AS
SELECT
  uri,
  rkey,
  title,
  subtitle,
  language,
  published_date,
  format,
  pages,
  duration_seconds,
  chapters,
  series::text AS series,
  book_edition,
  description,
  cover_url,
  to_char(
    (created_at AT TIME ZONE 'UTC'),
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS created_at,
  contributors::text AS contributors,
  publisher::text AS publisher,
  publishers::text AS publishers,
  identifiers::text AS identifiers
FROM appview_book;

COMMIT;
