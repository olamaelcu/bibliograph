-- Expression indexes for the jsonb predicates the read paths use.
--
-- `records.value` is untyped jsonb, and the shelving/review queries filter on
-- paths inside it rather than on columns, so every one of them was a sequential
-- scan. On production (21,853 records) that made `listShelvesWithBooks` take
-- 90-108 s and `getShelvingOfBook`'s mirror tier miss its budget entirely.
--
-- `if not exists` because these were applied by hand to production before this
-- migration existed; a fresh database gets them here.
CREATE INDEX IF NOT EXISTS "records_shelf_uri_idx" ON "records" USING btree ((value->>'shelf'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_book_uri_idx" ON "records" USING btree ((value->'book'->>'uri'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_hivebook_idx" ON "records" USING btree ((value->>'hiveBookUri'));
