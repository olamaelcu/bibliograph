-- Adopt community.lexicon.book edition/contributor shape.
--
-- Decisions (memory #283):
--   - Work concept collapsed; no `works` table created.
--   - Publishers not modeled yet; no `publishers` table.
--   - Cover/avatar images removed from record shapes; image lookup goes through
--     `net.olamaelcu.livtet.biblio.getImageFor{Book,Contributor}` queries.
--   - All historical OpenLibrary-imported data is dropped: the OL import pipeline
--     is defunct (memory #283) and the AppView is now GB-backed. Future records
--     materialize via GB lazy-load (getRecord?collection=community.lexicon.book.edition&rkey=gb-*).
--
-- Migration actions are idempotent — every block uses IF EXISTS / IF NOT EXISTS
-- guards so the file is safe to re-run on a partially-applied DB (no transactional
-- wrapper, no committed SQL beyond what auto-commit per statement gives us).

-- ─── 0. Rename books → editions (if needed) ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'books')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'editions') THEN
    EXECUTE 'ALTER TABLE books RENAME TO editions';
  END IF;
END$$;

-- ─── 1. Truncate all OL-imported data ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'editions') THEN
    EXECUTE 'TRUNCATE TABLE editions, contributors, book_identifiers, contributor_identifiers, book_contributors, book_genres, contributor_roles, formats, genres, genre_children, genre_identifiers CASCADE';
  END IF;
END$$;

-- ─── 2. Drop legacy columns on editions ────────────────────────────────────
ALTER TABLE "editions" DROP COLUMN IF EXISTS "format_pk";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "work_pk";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "cover_url";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "published_year_raw";

-- ─── 3. Rename publish_date → published_year (idempotent) ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'editions' AND column_name = 'published_year') THEN
    NULL;
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'editions' AND column_name = 'publish_date') THEN
    EXECUTE 'ALTER TABLE editions RENAME COLUMN publish_date TO published_year';
  END IF;
END$$;

-- ─── 4. Convert published_year to integer (year-only) ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'editions' AND column_name = 'published_year' AND data_type = 'bigint') THEN
    EXECUTE 'ALTER TABLE editions ALTER COLUMN published_year TYPE integer USING (CASE WHEN published_year IS NULL THEN NULL WHEN published_year > 9999 THEN extract(year FROM to_timestamp(published_year::bigint))::int WHEN published_year < 0 THEN NULL ELSE published_year::int END)';
  END IF;
END$$;

-- ─── 5. Add new community-edition columns ──────────────────────────────
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "subtitle" text;
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "language" text;
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "place" text;
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "work_uri" text;
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "publisher_uri" text;
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "contributors" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ─── 6. Drop obsolete tables ───────────────────────────────────────────────
DROP TABLE IF EXISTS "book_contributors" CASCADE;
DROP TABLE IF EXISTS "book_genres" CASCADE;
DROP TABLE IF EXISTS "contributor_roles" CASCADE;
DROP TABLE IF EXISTS "formats" CASCADE;
DROP TABLE IF EXISTS "genres" CASCADE;
DROP TABLE IF EXISTS "genre_children" CASCADE;
DROP TABLE IF EXISTS "genre_identifiers" CASCADE;

-- ─── 7. Rebuild book_identifiers with flipped (value_scheme, value, uri) ─
DROP TABLE IF EXISTS "book_identifiers" CASCADE;
CREATE TABLE "book_identifiers" (
	"book_pk" text NOT NULL,
	"value_scheme" text NOT NULL,
	"value" text NOT NULL,
	"uri" text NOT NULL,
	PRIMARY KEY ("book_pk", "value_scheme", "value"),
	CONSTRAINT "book_identifiers_book_pk_editions_pk_fk"
		FOREIGN KEY ("book_pk") REFERENCES "editions"("pk") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "book_identifiers_value_unique" ON "book_identifiers" ("value_scheme", "value");
CREATE INDEX "book_identifiers_uri_idx" ON "book_identifiers" ("uri");

-- ─── 8. Rebuild contributor_identifiers ───────────────────────────────
DROP TABLE IF EXISTS "contributor_identifiers" CASCADE;
CREATE TABLE "contributor_identifiers" (
	"contributor_pk" text NOT NULL,
	"value_scheme" text NOT NULL,
	"value" text NOT NULL,
	"uri" text NOT NULL,
	PRIMARY KEY ("contributor_pk", "value_scheme", "value"),
	CONSTRAINT "contributor_identifiers_contributor_pk_contributors_pk_fk"
		FOREIGN KEY ("contributor_pk") REFERENCES "contributors"("pk") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "contributor_identifiers_value_unique" ON "contributor_identifiers" ("value_scheme", "value");

-- ─── 9. contributors: drop image_url, add name_lower generated column ─
ALTER TABLE "contributors" DROP COLUMN IF EXISTS "image_url";
ALTER TABLE "contributors" ADD COLUMN IF NOT EXISTS "name_lower" text GENERATED ALWAYS AS (lower("name")) STORED;
CREATE INDEX IF NOT EXISTS "contributors_name_lower_idx" ON "contributors" ("name_lower");

-- ─── 10. Rename legacy PK index that survived the books → editions rename ─
ALTER INDEX IF EXISTS "books_pkey" RENAME TO "editions_pkey";