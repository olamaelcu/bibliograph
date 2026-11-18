-- 0010-edition-identifier-duration.sql
--
-- `duration_seconds` moves from the edition to the edition identifier.
--
-- Duration is a property of the audio product, exactly like `format` and
-- `pages`: two ISBNs of the same book can be a 12-hour abridged reading and a
-- 20-hour unabridged one. Holding one merged value on `books` destroyed that
-- evidence, so the claim joins the other five on `edition_identifier_info` and
-- the edition's public value becomes the rank union in
-- `edition_identifier_shape` (isbn13 → isbn10 → asin → any other issuer).
--
-- The backfill gives every identifier its edition's old value, so the union
-- reproduces today's number exactly; the drop is guarded, so re-applying this
-- file — every file is re-applied on deploy — is a no-op.

BEGIN;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'books'
       AND column_name = 'duration_seconds'
  ) THEN
    RETURN;
  END IF;

  -- Editions and identifiers are never one-without-the-other (ingest and the
  -- admin editor both require at least one identifier), so a non-null duration
  -- cannot be lost here.
  INSERT INTO edition_identifier_info
         (edition_uri, issuer, value, duration_seconds)
  SELECT i.edition_uri, i.issuer, i.value, e.duration_seconds
    FROM edition_identifiers i
    JOIN books e ON e.uri = i.edition_uri
   WHERE e.duration_seconds IS NOT NULL
  ON CONFLICT (edition_uri, issuer, value) DO UPDATE
    SET duration_seconds = EXCLUDED.duration_seconds, updated_at = now()
    WHERE edition_identifier_info.duration_seconds IS NULL;

  ALTER TABLE books DROP COLUMN duration_seconds;
END
$migration$;

COMMIT;
