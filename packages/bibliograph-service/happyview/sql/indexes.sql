-- Indexes for the activity reads HappyView serves. Idempotent; applied by
-- `pnpm hv:deploy` after HappyView has migrated `happyview_records`.

CREATE INDEX IF NOT EXISTS happyview_record_shelf_idx
  ON happyview.happyview_records (((record::jsonb)->>'shelf'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookShelving';
CREATE INDEX IF NOT EXISTS happyview_record_book_uri_idx
  ON happyview.happyview_records (((record::jsonb)->'book'->>'uri'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookShelving';
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
