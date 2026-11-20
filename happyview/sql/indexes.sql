-- Indexes for the activity reads HappyView serves. Idempotent; applied by
-- `mise run hv-deploy` after HappyView has migrated `happyview_records`.

-- Every statement here is `CREATE INDEX IF NOT EXISTS`: the file is applied on
-- every release, so a drop-and-recreate would rebuild that index on the live
-- table each time (two of these used to do exactly that). A partial index whose
-- predicate must change needs a new name, or a one-off drop on the host —
-- `IF NOT EXISTS` cannot alter an existing one.
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

-- One giveaway's entries: the entry record names the giveaway as a strongRef, so
-- the filter is on the nested `uri` rather than on a column. Every read of
-- `giveaway.listEntries`, the entry count on each card and the draw itself run
-- this predicate, and `record` is `text`, so the index has to carry the cast —
-- the same shape the `bookStatus` indexes above use.
CREATE INDEX IF NOT EXISTS happyview_records_giveaway_entry_giveaway
  ON happyview.happyview_records (((record::jsonb -> 'giveaway' ->> 'uri')))
  WHERE collection = 'net.olamaelcu.livtet.biblio.giveaway.entry';

-- `listReviewsByActor` unions the DID's reviews and its Bookhive reviews and
-- orders the union by `created_at DESC, uri DESC`. `(did, collection)` finds the
-- rows but nothing orders them, so each branch sorted the actor's whole history
-- (p50 4.6 s, p95 21 s, max 36 s on the host). With this index both branches are
-- an ordered walk, so the paging LIMIT stops the scan instead of sorting the
-- match set.
CREATE INDEX IF NOT EXISTS happyview_records_actor_created_idx
  ON happyview.happyview_records (did, collection, created_at DESC, uri DESC);

-- `getShelvingOfBook` filters `collection IN (bookStatus, shelfItem)` and then
-- the record's `book.uri`. The two partial book-uri indexes above cannot serve
-- an `IN` list (the planner cannot match an IN list to a single partial
-- predicate), so it read every status and shelfItem of the DID and filtered in
-- memory, with a correlated NOT EXISTS per row. This composite carries the same
-- expression across both collections.
CREATE INDEX IF NOT EXISTS happyview_records_actor_book_uri_idx
  ON happyview.happyview_records (did, collection, ((record::jsonb)->'book'->>'uri'));

-- `listShelvesWithBooks` pages a DID's shelves by a `uri` cursor; without `uri`
-- in the index the rows were fetched and then sorted (p95 1.2 s, max 15.8 s
-- under IO).
CREATE INDEX IF NOT EXISTS happyview_records_actor_uri_idx
  ON happyview.happyview_records (did, collection, uri);

-- `listShelvesWithBooks` runs one `entries` query per shelf on the page, and
-- each filtered `(record->>'shelf')` across every status and shelfItem of the
-- DID. Nothing indexed `shelf` together with the DID and collection, so a
-- 25-shelf page read the same rows 25 times (14 s average at the panel). This
-- makes each inner query an index descent; the correlated NOT EXISTS uses it
-- too.
CREATE INDEX IF NOT EXISTS happyview_records_actor_shelf_idx
  ON happyview.happyview_records (did, collection, ((record::jsonb)->>'shelf'));

-- `listReviewsByActor`'s Bookhive branch keeps only records whose `review` is
-- non-empty, but that predicate lives in the jsonb `record`; the existing
-- (did, collection, created_at DESC, uri DESC) index still fetched every
-- Bookhive row the actor wrote to evaluate it — 3845 rows and 794 heap blocks
-- for the busiest reviewer, 21 s on the first call. This partial index carries
-- the predicate, so the branch stops after the page's own rows.
CREATE INDEX IF NOT EXISTS happyview_record_bookhive_reviews_idx
  ON happyview.happyview_records (did, created_at DESC, uri DESC)
  WHERE collection = 'buzz.bookhive.book'
    AND btrim(COALESCE((record::jsonb)->>'review', '')) <> '';

-- `getFeedSkeleton`'s two Popfeed branches keep only book activity
-- (`creativeWorkType = 'book'`, and for shelf entries one of the three book
-- shelves). That filter lives in the jsonb record, so the shared
-- `(collection, FEED_TIME DESC, uri DESC)` index still walked the whole
-- collection in feed order to find a page: the listItem branch alone read
-- 27 285 buffers and 4.8 s for 51 rows. These partial indexes carry both the
-- collection and the predicate, so each branch is an index scan that stops
-- after the page.
CREATE INDEX IF NOT EXISTS happyview_records_popfeed_listitem_book_idx
  ON happyview.happyview_records (COALESCE((record::jsonb)->>'createdAt', (record::jsonb)->>'addedAt') DESC NULLS LAST, uri DESC)
  WHERE collection = 'social.popfeed.feed.listItem'
    AND (record::jsonb)->>'creativeWorkType' = 'book'
    AND (record::jsonb)->>'listType' IN ('read_books', 'currently_reading_books', 'to_read_books');

CREATE INDEX IF NOT EXISTS happyview_records_popfeed_review_book_idx
  ON happyview.happyview_records (COALESCE((record::jsonb)->>'createdAt', (record::jsonb)->>'addedAt') DESC NULLS LAST, uri DESC)
  WHERE collection = 'social.popfeed.feed.review'
    AND (record::jsonb)->>'creativeWorkType' = 'book';

-- Personalized feed pages iterate the viewer's dids (`unnest(dids)` + LATERAL)
-- for the two Popfeed branches. The planner will not use a did-leading index
-- under `did = ANY(...)`: it keeps the time-ordered partial index and walks it
-- looking for the few rows those dids wrote (1.4 s for 4 rows). Per-did
-- descents on these indexes answer the same branch in 11.9 ms for 13 dids.
CREATE INDEX IF NOT EXISTS happyview_records_popfeed_listitem_did_book_idx
  ON happyview.happyview_records (did, COALESCE((record::jsonb)->>'createdAt', (record::jsonb)->>'addedAt') DESC NULLS LAST, uri DESC)
  WHERE collection = 'social.popfeed.feed.listItem'
    AND (record::jsonb)->>'creativeWorkType' = 'book'
    AND (record::jsonb)->>'listType' IN ('read_books', 'currently_reading_books', 'to_read_books');

CREATE INDEX IF NOT EXISTS happyview_records_popfeed_review_did_book_idx
  ON happyview.happyview_records (did, COALESCE((record::jsonb)->>'createdAt', (record::jsonb)->>'addedAt') DESC NULLS LAST, uri DESC)
  WHERE collection = 'social.popfeed.feed.review'
    AND (record::jsonb)->>'creativeWorkType' = 'book';

-- Personalized feed pages take their bookStatus page per did, and the
-- `(did, collection, time, uri)` form was not chosen: the planner under-costs
-- the ordered scan and picks the shelf index plus a sort (313 ms for 13 dids).
-- The partial index carries the collection, so the ordered scan wins (26 ms).
CREATE INDEX IF NOT EXISTS happyview_records_bookstatus_feed_order_idx
  ON happyview.happyview_records (did, COALESCE((record::jsonb)->>'createdAt', (record::jsonb)->>'addedAt') DESC NULLS LAST, uri DESC)
  WHERE collection = 'net.olamaelcu.livtet.biblio.bookStatus';
