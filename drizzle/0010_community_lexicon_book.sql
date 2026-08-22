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
-- Migration actions (auto-commit per statement — dev-only, no concurrent traffic):
--   1. Truncate all OpenLibrary-imported data (editions, contributors,
--      book_identifiers, contributor_identifiers, book_contributors, etc.).
--      CASCADE handles FK constraints.
--   2. Drop legacy columns on editions (format_pk, work_pk, cover_url,
--      published_year_raw).
--   3. Rename editions columns to match new schema.ts.
--   4. Recreate identifier tables with new (value_scheme, value, uri) shape.
--   5. Recreate contributors with name_lower for case-insensitive dedup.

-- ─── 1. Truncate all OL-imported data ──────────────────────────────────────
TRUNCATE TABLE "editions", "contributors", "book_identifiers", "contributor_identifiers", "book_contributors", "book_genres", "contributor_roles", "formats", "genres", "genre_children", "genre_identifiers" CASCADE;

-- ─── 2. Drop legacy columns on editions ────────────────────────────────────
ALTER TABLE "editions" DROP COLUMN IF EXISTS "format_pk";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "work_pk";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "cover_url";
ALTER TABLE "editions" DROP COLUMN IF EXISTS "published_year_raw";

-- ─── 3. Rename publish_date → published_year (column was renamed in step 1's
--        half-applied state; we re-assert the final name explicitly).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editions' AND column_name = 'published_year'
  ) THEN
    -- Already named published_year; nothing to do.
    NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editions' AND column_name = 'publish_date'
  ) THEN
    ALTER TABLE "editions" RENAME COLUMN "publish_date" TO "published_year";
  END IF;
END$$;

-- ─── 4. Drop obsolete tables (after CASCADE truncate they may still exist) ──
DROP TABLE IF EXISTS "book_contributors" CASCADE;
DROP TABLE IF EXISTS "book_genres" CASCADE;
DROP TABLE IF EXISTS "contributor_roles" CASCADE;
DROP TABLE IF EXISTS "formats" CASCADE;
DROP TABLE IF EXISTS "genres" CASCADE;
DROP TABLE IF EXISTS "genre_children" CASCADE;
DROP TABLE IF EXISTS "genre_identifiers" CASCADE;

-- ─── 5. Rebuild book_identifiers with new (value_scheme, value, uri) shape ──
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

-- ─── 6. Rebuild contributor_identifiers with new shape ────────────────────
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

-- ─── 7. Add contributors.name_lower + drop contributors.image_url ────────
ALTER TABLE "contributors" DROP COLUMN IF EXISTS "image_url";
ALTER TABLE "contributors" ADD COLUMN IF NOT EXISTS "name_lower" text GENERATED ALWAYS AS (lower("name")) STORED;
CREATE INDEX IF NOT EXISTS "contributors_name_lower_idx" ON "contributors" ("name_lower");

-- ─── 8. Rename legacy PK index that survived the books → editions rename ───
ALTER INDEX IF EXISTS "books_pkey" RENAME TO "editions_pkey";