-- Greenfield AppView baseline.
--
-- This is a new deployment, not a migration: nothing in this database is
-- carried over. The earlier migrations still create the legacy tables on an
-- empty database; this migration removes them and rebuilds the catalog around
-- editions + join tables. Every table starts empty.

DROP TABLE IF EXISTS records CASCADE;
DROP TABLE IF EXISTS follows CASCADE;
DROP TABLE IF EXISTS works CASCADE;
DROP TABLE IF EXISTS edition_aliases CASCADE;
DROP TABLE IF EXISTS edition_work_backfill CASCADE;
DROP TABLE IF EXISTS edition_work_votes CASCADE;
DROP TABLE IF EXISTS actors CASCADE;
DROP TABLE IF EXISTS tap_dead_letter CASCADE;
DROP TABLE IF EXISTS ingest_dead_letter CASCADE;
DROP TABLE IF EXISTS oauth_sessions CASCADE;
DROP TABLE IF EXISTS oauth_states CASCADE;
DROP TABLE IF EXISTS web_sessions CASCADE;

-- A previous attempt at this baseline may have stopped halfway; these are the
-- objects it creates. Dropping them first makes the file idempotent, which
-- matters because drizzle applies statements one by one, not in a transaction.
DROP VIEW IF EXISTS appview_book_lua CASCADE;
DROP VIEW IF EXISTS appview_book CASCADE;
DROP TABLE IF EXISTS pds_outbox CASCADE;
DROP TABLE IF EXISTS pds_cids CASCADE;
DROP TABLE IF EXISTS edition_identifiers CASCADE;
DROP TABLE IF EXISTS edition_contributors CASCADE;
DROP TABLE IF EXISTS edition_publishers CASCADE;

-- The catalog is rebuilt with edition/contributor/publisher entities and join
-- tables. Dropping `editions` cascades away the old child FKs; the two
-- bookkeeping tables are re-attached below.
DROP TABLE IF EXISTS editions CASCADE;
DROP TABLE IF EXISTS contributors CASCADE;
DROP TABLE IF EXISTS publishers CASCADE;

-- The two bookkeeping tables survive the catalog drop but their rows name the
-- old editions; they are greenfield state, so clear them before re-attaching
-- the foreign key.
TRUNCATE TABLE edition_goodreads_backfill, edition_isbn_enrichment;
--> statement-breakpoint

CREATE TABLE pds_outbox (
  uri         text PRIMARY KEY,
  collection  text NOT NULL,
  rkey        text NOT NULL,
  op          text NOT NULL CHECK (op IN ('create','update','delete')),
  value       jsonb,
  attempts    integer NOT NULL DEFAULT 0,
  claimed_at  timestamptz,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pds_outbox_ready_idx ON pds_outbox (next_at) WHERE attempts < 10;

CREATE TABLE pds_cids (
  uri text PRIMARY KEY,
  cid text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE editions (
  uri                   text PRIMARY KEY,
  rkey                  text NOT NULL UNIQUE DEFAULT editions_next_tid(),
  title                 text NOT NULL,
  subtitle              text,
  language              text,
  published_date        text,
  format                text,
  pages                 integer,
  duration_seconds      integer,
  chapters              integer,
  series                jsonb,
  book_edition          text,
  description           text,
  cover_url             text,
  created_at            timestamptz NOT NULL,
  indexed_at            timestamptz NOT NULL DEFAULT now(),
  description_checked_at timestamptz,
  cover_checked_at      timestamptz
);
CREATE INDEX editions_created_at_idx ON editions (created_at DESC, uri);
CREATE INDEX editions_title_trgm_idx ON editions USING gin (title gin_trgm_ops);

CREATE TABLE edition_identifiers (
  edition_uri text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  issuer      text NOT NULL,
  value       text NOT NULL,
  PRIMARY KEY (edition_uri, issuer, value)
);
CREATE INDEX edition_identifiers_lookup_idx ON edition_identifiers (issuer, value);

CREATE TABLE contributors (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contributors_identity_idx ON contributors (lower(name), identifiers);
CREATE INDEX contributors_name_trgm_idx ON contributors USING gin (name gin_trgm_ops);
CREATE INDEX contributors_identifiers_idx ON contributors USING gin (identifiers);

CREATE TABLE publishers (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX publishers_identity_idx ON publishers (lower(name), identifiers);
CREATE INDEX publishers_name_trgm_idx ON publishers USING gin (name gin_trgm_ops);

CREATE TABLE edition_contributors (
  edition_uri    text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  contributor_id bigint NOT NULL REFERENCES contributors(id) ON DELETE RESTRICT,
  position       integer NOT NULL,
  role           text NOT NULL DEFAULT 'author',
  ref            text,
  PRIMARY KEY (edition_uri, position)
);
CREATE INDEX edition_contributors_contributor_idx ON edition_contributors (contributor_id);

CREATE TABLE edition_publishers (
  edition_uri  text NOT NULL REFERENCES editions(uri) ON DELETE CASCADE,
  publisher_id bigint NOT NULL REFERENCES publishers(id) ON DELETE RESTRICT,
  position     integer NOT NULL,
  PRIMARY KEY (edition_uri, position)
);
CREATE INDEX edition_publishers_publisher_idx ON edition_publishers (publisher_id);
--> statement-breakpoint

-- Re-attach the bookkeeping rows to the rebuilt catalog. The tables survive the
-- DROP ... CASCADE above with no data.
ALTER TABLE edition_goodreads_backfill
  ADD CONSTRAINT "edition_goodreads_backfill_uri_editions_uri_fk"
  FOREIGN KEY ("uri") REFERENCES "editions"("uri") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Lua hydration reads this; it is the only catalog object exposed to HappyView.
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
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'position', ec.position, 'name', c.name, 'role', ec.role,
      'identifiers', c.identifiers, 'ref', ec.ref
    )) ORDER BY ec.position)
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
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', p.name, 'identifiers', p.identifiers))
                     ORDER BY ep.position)
    FROM edition_publishers ep
    JOIN publishers p ON p.id = ep.publisher_id
    WHERE ep.edition_uri = e.uri
  ), '[]'::jsonb) AS publishers,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('issuer', i.issuer, 'value', i.value)
                     ORDER BY i.issuer, i.value)
    FROM edition_identifiers i WHERE i.edition_uri = e.uri
  ), '[]'::jsonb) AS identifiers
FROM editions e;
--> statement-breakpoint

-- HappyView's `db.raw` runs on the Any driver, which cannot decode Postgres
-- JSONB or TIMESTAMPTZ columns. This text-only projection is what the Lua
-- scripts read; TS reads `appview_book` above.
CREATE OR REPLACE VIEW appview_book_lua AS
SELECT
  uri, rkey, title, subtitle, language, published_date, format, pages,
  duration_seconds, chapters,
  series::text AS series,
  book_edition, description, cover_url,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  contributors::text AS contributors,
  publisher::text AS publisher,
  publishers::text AS publishers,
  identifiers::text AS identifiers
FROM appview_book;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pds_enqueue_edition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO pds_outbox (uri, collection, rkey, op)
    VALUES (OLD.uri, 'community.lexicon.media.book.edition', OLD.rkey, 'delete')
    ON CONFLICT (uri) DO UPDATE SET op='delete', value=NULL, updated_at=now();
    RETURN OLD;
  END IF;
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  VALUES (NEW.uri, 'community.lexicon.media.book.edition', NEW.rkey, CASE WHEN TG_OP='INSERT' THEN 'create' ELSE 'update' END)
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op='create' THEN 'create' ELSE EXCLUDED.op END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_editions AFTER INSERT OR UPDATE OR DELETE ON editions
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pds_enqueue_edition_child() RETURNS trigger AS $$
DECLARE target text;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.edition_uri ELSE NEW.edition_uri END;
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM editions e WHERE e.uri = target
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_identifiers AFTER INSERT OR UPDATE OR DELETE ON edition_identifiers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
CREATE TRIGGER pds_enqueue_contributors AFTER INSERT OR UPDATE OR DELETE ON edition_contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
CREATE TRIGGER pds_enqueue_publishers AFTER INSERT OR UPDATE OR DELETE ON edition_publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_edition_child();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pds_enqueue_contributor_editions() RETURNS trigger AS $$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_contributors ec JOIN editions e ON e.uri = ec.edition_uri
   WHERE ec.contributor_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pds_enqueue_publisher_editions() RETURNS trigger AS $$
BEGIN
  INSERT INTO pds_outbox (uri, collection, rkey, op)
  SELECT e.uri, 'community.lexicon.media.book.edition', e.rkey, 'update'
    FROM edition_publishers ep JOIN editions e ON e.uri = ep.edition_uri
   WHERE ep.publisher_id = NEW.id
  ON CONFLICT (uri) DO UPDATE SET
    op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
    value = NULL, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pds_enqueue_contributor_edits AFTER UPDATE OF name, identifiers ON contributors
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_contributor_editions();
CREATE TRIGGER pds_enqueue_publisher_edits AFTER UPDATE OF name, identifiers ON publishers
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_publisher_editions();
