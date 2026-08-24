-- drizzle/0005_search_and_identifiers.sql
-- Drop unused editions.search_vector GIN (the code uses ILIKE, not tsvector @@).
-- Add pg_trgm GINs on the three search columns + jsonb_path_ops GINs on every
-- identifiers column (used by @> containment queries).

DROP INDEX IF EXISTS "editions_search_idx";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "editions_title_trgm"        ON "editions"     USING GIN ("title" gin_trgm_ops);
CREATE INDEX "works_title_trgm"            ON "works"        USING GIN ("title" gin_trgm_ops);
CREATE INDEX "contributors_name_trgm"      ON "contributors" USING GIN ("name"  gin_trgm_ops);

CREATE INDEX "editions_identifiers_gin"     ON "editions"     USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "works_identifiers_gin"        ON "works"        USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "contributors_identifiers_gin" ON "contributors" USING GIN ("identifiers" jsonb_path_ops);
CREATE INDEX "publishers_identifiers_gin"   ON "publishers"   USING GIN ("identifiers" jsonb_path_ops);

--> statement-breakpoint