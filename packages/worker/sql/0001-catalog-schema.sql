-- 0001-catalog-schema.sql
--
-- Fresh-database bootstrap for the Bibliograph catalog (`public` schema).
--
-- This is the only schema a new deployment needs: the edge reads these tables,
-- the worker writes them, and HappyView joins `appview_book_lua` for book
-- hydration. There is no data migration and no seed. The catalog grows from
-- XRPC traffic (provider hydration -> edition rows -> pds_outbox ->
-- pds-publish).
--
-- Idempotent by construction:
--
--   * tables, sequences and indexes use IF NOT EXISTS;
--   * functions and views use CREATE OR REPLACE;
--   * triggers use CREATE OR REPLACE TRIGGER (PostgreSQL 14+).
--
-- It never drops or truncates a table, sequence, index, row or view, so it is
-- safe to re-run against an existing catalog database. It does not modify a
-- table that already exists; a column added by a later version belongs in a
-- later numbered file.
--
-- Retired: `packages/bibliograph-service` and its drizzle migrator. They are
-- not a dependency of a fresh database; graphile-worker creates its own schema
-- and `catalog_enqueue_marks` is created by the worker at boot.

BEGIN;

-- ---------------------------------------------------------------------------
-- TID rkeys
--
-- Editions are addressed by a 13-character base32-sortable TID, never by a
-- provider id or an ISBN. The low 10 bits are a sequence so two inserts in the
-- same microsecond still differ.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS editions_tid_seq AS bigint;

CREATE OR REPLACE FUNCTION editions_tid_encode(v bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT string_agg(
           substr('234567abcdefghijklmnopqrstuvwxyz', (((v >> (5 * i)) & 31) + 1)::int, 1),
           '' ORDER BY i DESC
         )
  FROM generate_series(0, 12) AS i;
$function$;

CREATE OR REPLACE FUNCTION editions_next_tid()
RETURNS text
LANGUAGE sql
AS $function$
  SELECT editions_tid_encode(
           ((extract(epoch FROM clock_timestamp()) * 1000000)::bigint << 10)
           | (nextval('editions_tid_seq') & 1023)
         );
$function$;

-- ---------------------------------------------------------------------------
-- Catalog entities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS editions (
  uri text PRIMARY KEY,
  rkey text NOT NULL DEFAULT editions_next_tid() UNIQUE,
  title text NOT NULL,
  subtitle text,
  language text,
  published_date text,
  format text,
  pages integer,
  duration_seconds integer,
  chapters integer,
  series jsonb,
  book_edition text,
  description text,
  cover_url text,
  created_at timestamp with time zone NOT NULL,
  indexed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS editions_created_at_idx
  ON editions (created_at DESC, uri);

CREATE TABLE IF NOT EXISTS edition_identifiers (
  edition_uri text NOT NULL REFERENCES editions (uri) ON DELETE CASCADE,
  issuer text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (edition_uri, issuer, value)
);

CREATE INDEX IF NOT EXISTS edition_identifiers_lookup_idx
  ON edition_identifiers (issuer, value);

CREATE TABLE IF NOT EXISTS contributors (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- `ON CONFLICT (lower(name), identifiers)` in ingest.js needs this exact
-- expression index to be the arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS contributors_identity_idx
  ON contributors (lower(name), identifiers);

CREATE TABLE IF NOT EXISTS edition_contributors (
  edition_uri text NOT NULL REFERENCES editions (uri) ON DELETE CASCADE,
  contributor_id bigint NOT NULL REFERENCES contributors (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  role text NOT NULL DEFAULT 'author',
  ref text,
  PRIMARY KEY (edition_uri, position)
);

CREATE INDEX IF NOT EXISTS edition_contributors_contributor_idx
  ON edition_contributors (contributor_id);

CREATE TABLE IF NOT EXISTS publishers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS publishers_identity_idx
  ON publishers (lower(name), identifiers);

CREATE TABLE IF NOT EXISTS edition_publishers (
  edition_uri text NOT NULL REFERENCES editions (uri) ON DELETE CASCADE,
  publisher_id bigint NOT NULL REFERENCES publishers (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  PRIMARY KEY (edition_uri, position)
);

CREATE INDEX IF NOT EXISTS edition_publishers_publisher_idx
  ON edition_publishers (publisher_id);

-- ---------------------------------------------------------------------------
-- PDS publication state
-- ---------------------------------------------------------------------------

-- One row per edition whose record is not yet in the publisher repo, or whose
-- published record is stale. `value` is deliberately unused: the record is
-- rebuilt from the catalog at publish time (edition-record.js).
CREATE TABLE IF NOT EXISTS pds_outbox (
  uri text PRIMARY KEY,
  collection text NOT NULL,
  rkey text NOT NULL,
  op text NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  value jsonb,
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamp with time zone,
  next_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Mirrors MAX_ATTEMPTS in publish.js: after ten failures the row is parked and
-- never claimed again (still visible to an operator).
CREATE INDEX IF NOT EXISTS pds_outbox_ready_idx
  ON pds_outbox (next_at)
  WHERE attempts < 10;

-- Last CID published per record, so create/update is chosen without a read.
CREATE TABLE IF NOT EXISTS pds_cids (
  uri text PRIMARY KEY,
  cid text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Provider response caches (see providers/http.js)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_books_cache (
  key text PRIMARY KEY,
  url text NOT NULL,
  body jsonb,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS google_books_cache_expires_at_idx
  ON google_books_cache (expires_at);

CREATE TABLE IF NOT EXISTS isbndb_cache (
  key text PRIMARY KEY,
  request text NOT NULL,
  body jsonb,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS isbndb_cache_expires_at_idx
  ON isbndb_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Outbox triggers
--
-- Any change to an edition, its identifiers, contributors or publisher queues
-- the edition for publication. A pending `create` is never downgraded to
-- `update`; `value` is cleared because the record is rebuilt at publish time.
-- `updated_at = now()` is what lets completeEntry/failEntry detect that the
-- row was rewritten while publishing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pds_enqueue_edition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO pds_outbox (uri, collection, rkey, op)
    VALUES (OLD.uri, 'community.lexicon.media.book.edition', OLD.rkey, 'delete')
    ON CONFLICT (uri) DO UPDATE SET op = 'delete', value = NULL, updated_at = now();
    RETURN OLD;
  END IF;

  INSERT INTO pds_outbox (uri, collection, rkey, op)
  VALUES (
    NEW.uri,
    'community.lexicon.media.book.edition',
    NEW.rkey,
    CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END
  )
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE EXCLUDED.op END,
    value = NULL,
    updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION pds_enqueue_edition_child()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target text;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.edition_uri ELSE NEW.edition_uri END;

  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM editions e
   WHERE e.uri = target
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL,
    updated_at = now();

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION pds_enqueue_contributor_editions()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT DISTINCT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_contributors ec
    JOIN editions e ON e.uri = ec.edition_uri
   WHERE ec.contributor_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL,
    updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION pds_enqueue_publisher_editions()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT DISTINCT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_publishers ep
    JOIN editions e ON e.uri = ep.edition_uri
   WHERE ep.publisher_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL,
    updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER pds_enqueue_editions
  AFTER INSERT OR UPDATE OR DELETE ON editions
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition();

CREATE OR REPLACE TRIGGER pds_enqueue_identifiers
  AFTER INSERT OR UPDATE OR DELETE ON edition_identifiers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();

CREATE OR REPLACE TRIGGER pds_enqueue_contributors
  AFTER INSERT OR UPDATE OR DELETE ON edition_contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();

CREATE OR REPLACE TRIGGER pds_enqueue_publishers
  AFTER INSERT OR UPDATE OR DELETE ON edition_publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();

CREATE OR REPLACE TRIGGER pds_enqueue_contributor_edits
  AFTER UPDATE OF name, identifiers ON contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_contributor_editions();

CREATE OR REPLACE TRIGGER pds_enqueue_publisher_edits
  AFTER UPDATE OF name, identifiers ON publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_publisher_editions();

-- ---------------------------------------------------------------------------
-- HappyView read models
--
-- `appview_book` is the typed read model described in docs/architecture.md.
-- `appview_book_lua` is the projection HappyView's Any driver actually reads:
-- jsonb and timestamptz cannot be decoded by that driver, so series,
-- contributors, publisher(s), identifiers and created_at are text.
--
-- Keep both: the typed view is the SQL-facing contract (and what web queries
-- can join), the text view is the HappyView contract (prelude.lua's
-- `edition_view`). The Lua scripts only read appview_book_lua.
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
               'ref', ec.ref
             )) ORDER BY ec.position
           )
      FROM edition_contributors ec
      JOIN contributors c ON c.id = ec.contributor_id
     WHERE ec.edition_uri = e.uri
  ), '[]'::jsonb) AS contributors,
  (
    SELECT jsonb_strip_nulls(jsonb_build_object('name', p.name, 'identifiers', p.identifiers))
      FROM edition_publishers ep
      JOIN publishers p ON p.id = ep.publisher_id
     WHERE ep.edition_uri = e.uri
     ORDER BY ep.position
     LIMIT 1
  ) AS publisher,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object('name', p.name, 'identifiers', p.identifiers))
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

COMMIT;
