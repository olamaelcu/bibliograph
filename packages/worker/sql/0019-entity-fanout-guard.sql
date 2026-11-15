-- 0019-entity-fanout-guard.sql
--
-- Re-ingesting an already-known edition queued it for republication even though
-- nothing about it changed. `ON CONFLICT ... DO UPDATE` is an UPDATE even when
-- every SET value equals the stored one, so four trigger families fired on
-- no-op writes and the queue was rewritten wholesale on every ingest:
--
--   * `AFTER UPDATE OF name, identifiers` on `contributors`/`publishers`
--     (0001, 0008) fired on the entity upsert in `linkContributors`/
--     `linkPublisher` and fanned out to every edition crediting the entity.
--     Measured on production: 93M outbox row writes for ~300k entity writes.
--   * The same no-op upsert on `edition_contributors` and
--     `edition_identifier_publishers` fired the unconditional child trigger
--     (0001, 0008), re-queueing the edition itself.
--   * An entity's own record trigger (0004) queued the contributor/publisher
--     record on every such update too.
--
-- The ingests keep supplying `ON CONFLICT ... DO UPDATE`: `linkContributors`
-- and `linkPublisher` read `RETURNING id`, and a `WHERE` on the DO UPDATE
-- suppresses the returned row. So the fix lives in the triggers, which compare
-- values instead of trusting the statement's `UPDATE OF` column list.
--
-- Two mechanisms, because `WHEN` cannot reference OLD on an INSERT trigger
-- ("INSERT trigger's WHEN condition cannot reference OLD values"):
--
--   * UPDATE-only triggers (the entity fan-outs) guard in `WHEN`, so a no-op
--     statement does not even call the function.
--   * Triggers that also cover INSERT and DELETE (`pds_enqueue_edition_child`,
--     `pds_enqueue_entity`) open with the same comparison inside the function.
--     INSERT and DELETE always change the row set, so they keep queueing: the
--     guard only skips `TG_OP = 'UPDATE'` with an identical tuple.
--
-- `IS DISTINCT FROM` is case-sensitive, so a case-only rename still fans out:
-- `lower(name)` is the conflict key, so that is the one value difference a
-- re-ingest can produce.
--
-- Additive and idempotent like the rest of the directory: `CREATE OR REPLACE`
-- for every function and trigger below, so re-applying on deploy is a no-op.
-- 0001/0004/0008 are re-applied first on every deploy and define the original
-- bodies and triggers; this file sorts last and restores the guards.

BEGIN;

-- ---------------------------------------------------------------------------
-- Child links and entity records: a no-op UPDATE queues nothing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pds_enqueue_edition_child()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target text;
BEGIN
  -- An upsert that rewrote identical values is not a change: the edition's
  -- identifiers, contributors and publisher links are the same, so the
  -- published record would be identical too.
  IF TG_OP = 'UPDATE' AND OLD.* IS NOT DISTINCT FROM NEW.* THEN
    RETURN NEW;
  END IF;

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

CREATE OR REPLACE FUNCTION pds_enqueue_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Same rule for the entity's own record: a no-op update publishes nothing.
  IF TG_OP = 'UPDATE' AND OLD.* IS NOT DISTINCT FROM NEW.* THEN
    RETURN NEW;
  END IF;

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

-- ---------------------------------------------------------------------------
-- Entity fan-out: only a real rename republishes the crediting editions
-- ---------------------------------------------------------------------------

-- `AFTER UPDATE OF name, identifiers` fires whenever those columns appear in
-- the SET list, not when their value changes, and the ingest upsert always
-- names `name`. Compare the values instead.
CREATE OR REPLACE TRIGGER pds_enqueue_contributor_edits
  AFTER UPDATE OF name, identifiers ON contributors
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.identifiers IS DISTINCT FROM NEW.identifiers)
  EXECUTE FUNCTION pds_enqueue_contributor_editions();

CREATE OR REPLACE TRIGGER pds_enqueue_publisher_edits
  AFTER UPDATE OF name, identifiers ON publishers
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.identifiers IS DISTINCT FROM NEW.identifiers)
  EXECUTE FUNCTION pds_enqueue_publisher_editions();

COMMIT;
