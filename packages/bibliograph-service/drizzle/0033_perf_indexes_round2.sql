-- Second performance index pass.
--
-- Six additive indexes that match predicates the code already issues but no
-- index could serve, plus two drops of indexes that only cost write time. The
-- two expression indexes on `records` are written exactly as the SQL builders
-- emit them (`shelving/shelf-rows.ts` bookhiveSubjectSql, and the review query
-- in `xrpc-router.ts`); a whitespace or literal difference would leave them
-- unused.
--
-- Applied with `pnpm --filter bibliograph-service run db:run`. Every statement
-- below is separated by a statement-breakpoint marker because that migrator
-- feeds each fragment to `client.query` on its own: a multi-statement simple
-- query runs in an implicit transaction block, and CREATE INDEX CONCURRENTLY is
-- refused there. (`drizzle-kit migrate` wraps the whole file in one transaction
-- for the same reason.)

-- 1. Bookhive shelving subject ("who shelved this book"). The existing
--    records_hivebook_idx is on the bare `value->>'hiveBookUri'`; the code folds
--    the legacy `hiveId` shape through `coalesce(...)`, which no index matched.
--    Measured before this index: Seq Scan over all 147,564 `records` rows,
--    200 ms. The literal DID must stay in step with `bookhive/keys.ts`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "records_hivebook_subject_idx"
  ON "records" ((coalesce(value->>'hiveBookUri',
    'at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/' || (value->>'hiveId'))))
  WHERE "collection" = 'buzz.bookhive.book';

--> statement-breakpoint
-- 2. Bookhive reading status: `listShelvesWithBooks` previews one shelf at a
--    time with `did` + `value->>'status'`, and `bookhiveShelfContainers`
--    derives shelves from the same predicate. Measured before: 102 ms per shelf
--    preview, because the collection filter alone had to be scanned.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "records_bookhive_status_idx"
  ON "records" ("did", ((value->>'status')))
  WHERE "collection" = 'buzz.bookhive.book' AND (value->>'status') IS NOT NULL;

--> statement-breakpoint
-- 3. The two legacy review refs. `getReviewsByBook` ORs three shapes for a
--    review's book; only `(value->'book'->>'uri')` is indexed (0016), so the OR
--    could not be pruned and the read fell back to scanning `records`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "records_review_book_legacy_idx"
  ON "records" (((value->>'book')))
  WHERE "collection" = 'net.olamaelcu.livtet.biblio.bookReview';

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "records_review_book_ref_idx"
  ON "records" (((value->'book'->>'ref')))
  WHERE "collection" = 'net.olamaelcu.livtet.biblio.bookReview';

--> statement-breakpoint
-- 4. `searchPublishers` filters `name ILIKE '%q%'`. 0005 created the trigram
--    indexes for editions/works/contributors and skipped publishers, so every
--    publisher query full-scanned the table twice (page + count).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "publishers_name_trgm"
  ON "publishers" USING GIN ("name" gin_trgm_ops);

--> statement-breakpoint
-- 5. `forgetVoteByRecordUri` deletes by `record_uri`; the only indexes are the
--    composite primary key and the (now dropped) edition index, so every vote
--    deletion was a sequential scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "edition_work_votes_record_uri_idx"
  ON "edition_work_votes" ("record_uri");

--> statement-breakpoint
-- 6. The "For You" feed joins works by shared subjects. Default `jsonb_ops`
--    (not jsonb_path_ops) on purpose: it supports the `?|` array prefilter the
--    feed now issues ahead of expanding `subjects`, which `jsonb_path_ops`
--    cannot answer.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "works_subjects_gin"
  ON "works" USING GIN ("subjects");

--> statement-breakpoint
-- 7. Pure write cost: `edition_work_votes_edition_idx` duplicates the leading
--    column of `pk(edition_uri, voter_did)`, and `labels_subject_idx (uri)` is a
--    prefix of `labels_subject_val_idx (uri, val)`.
DROP INDEX IF EXISTS "edition_work_votes_edition_idx";

--> statement-breakpoint
DROP INDEX IF EXISTS "labels_subject_idx";
