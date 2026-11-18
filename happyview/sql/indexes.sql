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
-- Dropped: a GIN index over an expression on a `text` column has to parse the
-- whole record and tokenize the identifier array on every insert, and
-- `pg_stat_user_indexes` recorded 0 scans for it on a 371k-row table while the
-- server was spending ~2.9s mean in `INSERT INTO happyview_records`. Nothing
-- reads reviews by identifier set; the subject-record index above covers the
-- reads that exist.
DROP INDEX IF EXISTS happyview.happyview_record_review_identifiers_idx;

CREATE INDEX IF NOT EXISTS happyview_record_follow_subject_idx
  ON happyview.happyview_records (((record::jsonb)->>'subject'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.follow';

-- One record's reactions, newest first: the subject is what a reaction page
-- filters on, and `(created_at DESC, uri DESC)` is the order it pages in.
CREATE INDEX IF NOT EXISTS happyview_record_reaction_subject_idx
  ON happyview.happyview_records (((record::jsonb)->'subject'->>'uri'))
  WHERE collection = 'community.lexicon.interaction.reaction';

-- One review's replies, oldest first: `subject` is a plain at-uri here, so the
-- filter is on the string itself.
CREATE INDEX IF NOT EXISTS happyview_record_review_reply_subject_idx
  ON happyview.happyview_records (((record::jsonb)->>'subject'))
  WHERE collection = 'net.olamaelcu.livtet.biblio.reviewReply';

-- The join key from a Bookhive per-book record to the edition its hive id was
-- imported as (`appview_bookhive_lua`). Recency ordering is already covered by
-- 0003-feed-read.sql's `(collection, record->>'createdAt' DESC, uri DESC)`.
CREATE INDEX IF NOT EXISTS happyview_record_bookhive_hive_idx
  ON happyview.happyview_records (((record::jsonb)->>'hiveId'))
  WHERE collection = 'buzz.bookhive.book';
