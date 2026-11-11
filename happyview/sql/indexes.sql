-- Indexes for the activity reads HappyView serves. Idempotent; applied by
-- `mise run hv-deploy` after HappyView has migrated `happyview_records`.

-- These two were built with the old collection name. Dropping first is the only
-- way to change a partial index's predicate: `IF NOT EXISTS` would keep the
-- stale one because the name already exists. The drop must be schema-qualified:
-- psql resolves an unqualified index name against `search_path` (public for the
-- `bibliograph` role), not against the table being indexed.
DROP INDEX IF EXISTS happyview.happyview_record_shelf_idx;
DROP INDEX IF EXISTS happyview.happyview_record_book_uri_idx;
CREATE INDEX IF NOT EXISTS happyview_record_shelf_idx
  ON happyview.happyview_records (((record::jsonb)->>'shelf'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookStatus';
CREATE INDEX IF NOT EXISTS happyview_record_book_uri_idx
  ON happyview.happyview_records (((record::jsonb)->'book'->>'uri'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookStatus';

CREATE INDEX IF NOT EXISTS happyview_record_shelfitem_shelf_idx
  ON happyview.happyview_records (((record::jsonb)->>'shelf'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.shelfItem';
CREATE INDEX IF NOT EXISTS happyview_record_shelfitem_book_idx
  ON happyview.happyview_records (((record::jsonb)->'book'->>'uri'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.shelfItem';

CREATE INDEX IF NOT EXISTS happyview_record_review_subject_record_idx
  ON happyview.happyview_records (((record::jsonb)->>'subjectRecord'))
  WHERE collection = 'community.lexicon.media.book.review';
CREATE INDEX IF NOT EXISTS happyview_record_review_identifiers_idx
  ON happyview.happyview_records USING gin (((record::jsonb)->'subject'->'identifiers'))
  WHERE collection = 'community.lexicon.media.book.review';

CREATE INDEX IF NOT EXISTS happyview_record_follow_subject_idx
  ON happyview.happyview_records (((record::jsonb)->>'subject'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.follow';
