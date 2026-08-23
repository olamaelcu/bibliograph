-- Full-text search support for editions.
-- Adds a generated tsvector column and a GIN index. drizzle-kit ignores
-- functional indexes / generated columns (see project memory #179), so this
-- is hand-authored after the schema migration.
ALTER TABLE "editions"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce("title", '') || ' ' ||
      coalesce("description", '') || ' ' ||
      coalesce("place", '')
    )
  ) STORED;
--> statement-breakpoint

CREATE INDEX "editions_search_idx" ON "editions" USING GIN ("search_vector");
