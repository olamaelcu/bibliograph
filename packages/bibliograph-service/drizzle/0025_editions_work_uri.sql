-- The recommendation feed walks subject-sharing works back to their editions
-- (`editions e JOIN scored s ON e.work_uri = s.work_uri`). Without this index
-- that join is a sequential scan of the whole catalog on every "For You" read.
-- Partial: an edition with no work cannot be a recommendation candidate, so the
-- index only carries the rows the join can use.
CREATE INDEX IF NOT EXISTS "editions_work_uri_idx" ON "editions" USING btree ("work_uri") WHERE "work_uri" IS NOT NULL;
