-- 0008-edition-identifier-publishers.sql
--
-- Publisher links move from the edition onto the edition identifier.
--
-- A provider record credits a publisher for a specific product: one ISBN is
-- published by Penguin, another by Ace. The edition-level
-- `edition_publishers` link could only keep one merged answer, so it is
-- replaced by `edition_identifier_publishers`, keyed by the same
-- (edition_uri, issuer, value) triple as `edition_identifiers` and cascading
-- from it. Each link is a real FK to `publishers`, so lookups keep the entity
-- `at_uri` and identifiers instead of a duplicated name.
--
-- The published record's `publisher` is the head of the per-edition ordered
-- list in `edition_publishers_shape` (identifier rank, then position) and its
-- `publishers` array is that whole list, deduped by first occurrence. The
-- `edition_identifier_info.publisher` text claim added by 0007 is dropped:
-- the FK supersedes it and the report reads the entity name.
--
-- Every file is re-applied on deploy, and 0001/0004/0007 recreate DDL that
-- names `edition_publishers`, so those definitions are guarded on its
-- existence there and this file owns the read model from here on. The drop is
-- guarded too: a second run is a no-op.

BEGIN;

-- ---------------------------------------------------------------------------
-- Per-identifier publisher links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edition_identifier_publishers (
  edition_uri text NOT NULL,
  issuer text NOT NULL,
  value text NOT NULL,
  publisher_id bigint NOT NULL REFERENCES publishers (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  PRIMARY KEY (edition_uri, issuer, value, position),
  FOREIGN KEY (edition_uri, issuer, value)
    REFERENCES edition_identifiers (edition_uri, issuer, value)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS edition_identifier_publishers_publisher_idx
  ON edition_identifier_publishers (publisher_id);

-- One ordered publisher list per edition: the best-ranked identifier first
-- (isbn13 → isbn10 → asin → any other issuer), then that identifier's
-- position. A publisher credited by several identifiers keeps its first
-- occurrence, so a merged edition does not repeat a name.
CREATE OR REPLACE VIEW edition_publishers_shape AS
SELECT edition_uri,
       array_agg(publisher_id ORDER BY rk, issuer, value, position) AS publisher_ids
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

-- ---------------------------------------------------------------------------
-- Read models: publisher objects come from the ordered list
--
-- Same columns and order as 0001/0004/0007 — only the two publisher
-- expressions change, so `appview_book_lua` and HappyView's `edition_view`
-- need no change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW appview_book AS
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
      FROM edition_publishers_shape ps
      JOIN publishers p ON p.id = ps.publisher_ids[1]
     WHERE ps.edition_uri = e.uri
  ) AS publisher,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'name', p.name,
               'identifiers', p.identifiers,
               'ref', p.at_uri
             ))
             ORDER BY ord.idx
           )
      FROM edition_publishers_shape ps
      CROSS JOIN LATERAL unnest(ps.publisher_ids) WITH ORDINALITY AS ord(id, idx)
      JOIN publishers p ON p.id = ord.id
     WHERE ps.edition_uri = e.uri
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
LEFT JOIN edition_identifier_shape s ON s.edition_uri = e.uri;

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

-- HappyView reads the catalog through the public schema. If its role already
-- exists (db-init.sql or a previous deployment), grant it read access here so a
-- fresh database needs one fewer manual step. No role, no grant.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO happyview_app';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO happyview_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO happyview_app';
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- Outbox triggers
--
-- A link change queues its edition (the child helper keys off
-- `edition_uri`), and renaming a publisher queues every edition that credits
-- it through any of its identifiers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TRIGGER pds_enqueue_publishers
  AFTER INSERT OR UPDATE OR DELETE ON edition_identifier_publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();

CREATE OR REPLACE FUNCTION pds_enqueue_publisher_editions()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT DISTINCT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_identifier_publishers ip
    JOIN editions e ON e.uri = ip.edition_uri
   WHERE ip.publisher_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL,
    updated_at = now();
  RETURN NEW;
END;
$function$;

-- A publisher rename must republish every edition that credits it through any
-- of its identifiers.
CREATE OR REPLACE TRIGGER pds_enqueue_publisher_edits
  AFTER UPDATE OF name, identifiers ON publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_publisher_editions();

-- ---------------------------------------------------------------------------
-- Backfill and drop
--
-- Every identifier of an edition inherits the edition's publisher links, so
-- the ordered list reproduces today's `publishers` array exactly. Guarded on
-- the old table, so a second run returns immediately.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF to_regclass(current_schema() || '.edition_publishers') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO edition_identifier_publishers
         (edition_uri, issuer, value, publisher_id, position)
  SELECT i.edition_uri, i.issuer, i.value, ep.publisher_id, ep.position
    FROM edition_publishers ep
    JOIN edition_identifiers i ON i.edition_uri = ep.edition_uri
  ON CONFLICT (edition_uri, issuer, value, position) DO NOTHING;

  DROP TABLE edition_publishers;
END
$migration$;

-- The sixth claim is now a link, not text.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'edition_identifier_info'
       AND column_name = 'publisher'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE edition_identifier_info DROP COLUMN publisher;
END
$migration$;

COMMIT;
