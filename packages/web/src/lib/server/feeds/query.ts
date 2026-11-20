/**
 * Feed skeleton queries over `happyview.happyview_records`.
 *
 * The edge reads the activity index directly so the public feed needs no
 * upstream call and personalized feeds are one indexed query over the viewer's
 * follow set. No PDS read, no worker task, no HappyView script.
 */

export const REVIEW_COLLECTION = 'community.lexicon.media.book.review';
export const BOOK_STATUS_COLLECTION = 'net.olamaelcu.livtet.biblio.bookStatus';
export const FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow';
/**
 * Bookhive's per-book record. Not a Bibliograph collection, but its records
 * shelve (and, with review text, review) a catalog edition, so the feed
 * carries them too.
 */
export const BUZZ_BOOKHIVE_BOOK = 'buzz.bookhive.book';
/**
 * Popfeed's book activity: a review (rating 0-10 plus optional text) and a
 * shelf membership (`listType`). Not Bibliograph collections, but a Livtet
 * reader's Popfeed activity is book activity, so the feed carries it.
 */
export const POPFEED_REVIEW_COLLECTION = 'social.popfeed.feed.review';
export const POPFEED_LIST_ITEM_COLLECTION = 'social.popfeed.feed.listItem';

/**
 * Bookhive's reading statuses, spelled the way the Livtet client expects in a
 * `bookhive:` reason (its `BIBLIO_READING_STATUSES` keys).
 */
const BOOKHIVE_SHELF: Record<string, string> = {
  'buzz.bookhive.defs#reading': 'reading',
  'buzz.bookhive.defs#finished': 'read',
  'buzz.bookhive.defs#wantToRead': 'to-read',
  'buzz.bookhive.defs#abandoned': 'dnf'
};

/** Popfeed's shelf vocabulary, mapped onto the Livtet keys a reason carries. */
const POPFEED_SHELF: Record<string, string> = {
  read_books: 'read',
  currently_reading_books: 'reading',
  to_read_books: 'to-read'
};

/**
 * A record's own activity time. Popfeed's shelf entries carry `addedAt` and no
 * `createdAt`, so the order and the cursor read one expression for every
 * collection — which is also what 0020-feed-popfeed.sql indexes.
 */
const FEED_TIME = `COALESCE(record::jsonb->>'createdAt', record::jsonb->>'addedAt')`;

export const FEED_KINDS = ['public', 'following', 'extended', 'dynamic'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** Enough of `pg.Pool` for these queries; tests pass a fake. */
export type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type FeedCursor = { c: string | null; u: string };

export type FeedSkeletonItem = { post: string; reason?: string };

export type FeedSkeleton = { feed: FeedSkeletonItem[]; cursor?: string };

/** A follow set is bounded so one account cannot ask for an unbounded `ANY` list. */
export const MAX_FEED_DIDS = 500;

type FeedRow = {
  uri: string;
  collection: string;
  record: unknown;
  created_at: string | null;
  /** The edition a Bookhive record's `hiveId` was imported as; null otherwise. */
  book_uri: string | null;
};

/** Opaque base64url JSON `{c,u}`; malformed input is rejected, never silently restarted. */
export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.c, u: cursor.u }), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): FeedCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { c, u } = parsed as Record<string, unknown>;
  if (c !== null && typeof c !== 'string') return null;
  if (typeof u !== 'string' || u === '') return null;
  return { c, u };
}

/**
 * The book a review or shelving record refers to, when it names one.
 *
 * A Bibliograph review names its edition in `subjectRecord`, else in the first
 * `atproto` identifier of its inline `subject`; a bookStatus names it in
 * `book.uri`; a Bookhive record gets it from the edition its `hiveId` resolved
 * to (`bookUri`), and its reason carries the shelf it was filed under.
 */
export function reasonFor(
  collection: string,
  record: unknown,
  bookUri: string | null = null
): string | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;

  // Bookhive's own record shape: the shelf comes from `status`, the book from
  // the edition the row's `hiveId` resolved to. This `bookhive:<shelf>|<uri>`
  // spelling is what Livtet's `parseBookhiveReason` reads; with no known status
  // the prefix is empty and the client falls back to the record's own status.
  if (collection === BUZZ_BOOKHIVE_BOOK) {
    const status = value.status;
    const shelf = typeof status === 'string' ? BOOKHIVE_SHELF[status] : undefined;
    const prefix = `bookhive:${shelf ?? ''}`;
    return bookUri === null ? prefix : `${prefix}|${bookUri}`;
  }

  if (collection === REVIEW_COLLECTION) {
    if (typeof value.subjectRecord === 'string' && value.subjectRecord !== '') {
      return value.subjectRecord;
    }
    const subject = value.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined;
    const identifiers = (subject as Record<string, unknown>).identifiers;
    if (!Array.isArray(identifiers)) return undefined;
    for (const identifier of identifiers) {
      if (identifier === null || typeof identifier !== 'object' || Array.isArray(identifier)) {
        continue;
      }
      const entry = identifier as Record<string, unknown>;
      if (entry.issuer === 'atproto' && typeof entry.value === 'string' && entry.value !== '') {
        return entry.value;
      }
    }
    return undefined;
  }

  if (collection === BOOK_STATUS_COLLECTION) {
    const book = value.book;
    if (book === null || typeof book !== 'object' || Array.isArray(book)) return undefined;
    const uri = (book as Record<string, unknown>).uri;
    return typeof uri === 'string' && uri !== '' ? uri : undefined;
  }

  // Popfeed's two book records name no edition: the row's ISBN/ASIN lookup
  // resolved it (`bookUri`). Without a match the reason keeps its
  // `popfeed:<token>` prefix — the same degradation a Bookhive record whose
  // `hiveId` was never imported already has — and the client falls back to the
  // record's own `title`/`posterUrl`.
  if (collection === POPFEED_REVIEW_COLLECTION) {
    const prefix = 'popfeed:review';
    return bookUri === null ? prefix : `${prefix}|${bookUri}`;
  }

  if (collection === POPFEED_LIST_ITEM_COLLECTION) {
    const listType = value.listType;
    const shelf = typeof listType === 'string' ? POPFEED_SHELF[listType] : undefined;
    if (shelf === undefined) return undefined;
    const prefix = `popfeed:${shelf}`;
    return bookUri === null ? prefix : `${prefix}|${bookUri}`;
  }

  return undefined;
}

function asFeedRow(row: unknown): FeedRow | null {
  if (row === null || typeof row !== 'object') return null;
  const value = row as Record<string, unknown>;
  if (typeof value.uri !== 'string') return null;
  return {
    uri: value.uri,
    collection: typeof value.collection === 'string' ? value.collection : '',
    record: value.record,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    book_uri: typeof value.book_uri === 'string' ? value.book_uri : null
  };
}

function didFromRow(row: unknown): string | null {
  if (row === null || typeof row !== 'object' || !('did' in row)) return null;
  return normalizeFollowSubject(row.did);
}

/**
 * Follow records name their target either as a bare DID (HappyView graph
 * scripts) or as an `at://` URI (Livtet's writer). Normalizing on read keeps
 * existing rows valid without a migration.
 */
export function normalizeFollowSubject(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const subject = value.startsWith('at://') ? value.slice('at://'.length) : value;
  return subject.startsWith('did:') ? subject : null;
}

async function followSubjects(pool: Queryable, viewerDid: string): Promise<string[]> {
  const result = await pool.query(
    `WITH follows AS (
       SELECT DISTINCT record::jsonb->>'subject' AS subject
         FROM happyview.happyview_records
        WHERE did = $1
          AND collection = $2
     ), normalized AS (
       SELECT DISTINCT CASE
                WHEN subject LIKE 'at://%' THEN substr(subject, 6)
                ELSE subject
              END AS did
         FROM follows
     )
     SELECT did
       FROM normalized
      WHERE did LIKE 'did:%'
        AND did <> $1
      ORDER BY did
      LIMIT $3`,
    [viewerDid, FOLLOW_COLLECTION, MAX_FEED_DIDS]
  );
  return result.rows.map(didFromRow).filter((did): did is string => did !== null);
}

async function extendedSubjects(pool: Queryable, viewerDid: string): Promise<string[]> {
  const result = await pool.query(
    `WITH follows AS (
       SELECT DISTINCT CASE
                WHEN record::jsonb->>'subject' LIKE 'at://%'
                  THEN substr(record::jsonb->>'subject', 6)
                ELSE record::jsonb->>'subject'
              END AS did
         FROM happyview.happyview_records
        WHERE did = $1
          AND collection = $2
     ), hop1 AS (
       SELECT DISTINCT did
         FROM follows
        WHERE did LIKE 'did:%'
          AND did <> $1
     ), hop2 AS (
       SELECT DISTINCT CASE
                WHEN r.record::jsonb->>'subject' LIKE 'at://%'
                  THEN substr(r.record::jsonb->>'subject', 6)
                ELSE r.record::jsonb->>'subject'
              END AS did
         FROM happyview.happyview_records r
         JOIN hop1 ON hop1.did = r.did
        WHERE r.collection = $2
     )
     SELECT did
       FROM (SELECT did FROM hop1 UNION SELECT did FROM hop2) AS dids
      WHERE did LIKE 'did:%' AND did <> $1
      ORDER BY did
      LIMIT $3`,
    [viewerDid, FOLLOW_COLLECTION, MAX_FEED_DIDS]
  );
  return result.rows.map(didFromRow).filter((did): did is string => did !== null);
}

/**
 * The DIDs whose records a feed may page.
 *
 * `public` is unfiltered (`null`). `following` is the viewer's follow set,
 * `extended` adds the followees' followees, and `dynamic` is the viewer plus
 * the follow set — the per-viewer ladder, with `following` excluding the
 * viewer and `dynamic` including them.
 */
export async function feedDids(
  pool: Queryable,
  kind: FeedKind,
  viewerDid: string | null
): Promise<string[] | null> {
  if (kind === 'public') return null;
  if (viewerDid === null) return [];

  if (kind === 'following') return followSubjects(pool, viewerDid);
  if (kind === 'extended') return extendedSubjects(pool, viewerDid);
  const followed = await followSubjects(pool, viewerDid);
  return [viewerDid, ...followed.filter((did) => did !== viewerDid)];
}

/** One timed phase of a skeleton page; the edge maps these to metrics. */
export type FeedPageObservation =
  | { event: 'follow_dids'; kind: FeedKind; dids: number; durationSeconds: number }
  | { event: 'page'; kind: FeedKind; durationSeconds: number };

export type FeedPageOptions = {
  kind: FeedKind;
  viewerDid: string | null;
  limit: number;
  cursor?: FeedCursor | null;
  /** Optional sink for per-phase timings; absent in tests that do not care. */
  observe?: (observation: FeedPageObservation) => void;
};

/**
 * Page the five activity collections newest first by the record's own activity
 * time (its `createdAt`, else Popfeed's `addedAt`), then `uri` descending.
 * `limit + 1` rows decide whether another page exists; the cursor is built from
 * the last emitted row.
 */
export async function fetchFeedPage(
  pool: Queryable,
  options: FeedPageOptions
): Promise<FeedSkeleton> {
  const didsStarted = performance.now();
  const dids = await feedDids(pool, options.kind, options.viewerDid);
  if (dids !== null) {
    options.observe?.({
      event: 'follow_dids',
      kind: options.kind,
      dids: dids.length,
      durationSeconds: (performance.now() - didsStarted) / 1000
    });
  }
  if (dids !== null && dids.length === 0) return { feed: [] };

  // The five paged collections, each with the predicate that keeps a branch to
  // book activity. A Popfeed record of another work type names no edition and
  // is not book activity; its shelf lives in `listType` (the schema's `status`
  // is never set in the wild), and only the three book shelves are paged.
  const branches: { collection: string; filter: string }[] = [
    { collection: REVIEW_COLLECTION, filter: '' },
    { collection: BOOK_STATUS_COLLECTION, filter: '' },
    { collection: BUZZ_BOOKHIVE_BOOK, filter: '' },
    {
      collection: POPFEED_REVIEW_COLLECTION,
      filter: ` AND record::jsonb->>'creativeWorkType' = 'book'`
    },
    {
      collection: POPFEED_LIST_ITEM_COLLECTION,
      filter: ` AND record::jsonb->>'creativeWorkType' = 'book'
        AND record::jsonb->>'listType' IN ('read_books', 'currently_reading_books', 'to_read_books')`
    }
  ];
  const values: unknown[] = branches.map((branch) => branch.collection);

  if (dids !== null) {
    values.push(dids);
  }
  const didParam = dids === null ? null : `$${values.length}`;

  if (options.cursor) {
    values.push(options.cursor.c, options.cursor.u);
  }
  const cursorParams = options.cursor
    ? { time: `$${values.length - 1}`, uri: `$${values.length}` }
    : null;

  values.push(options.limit + 1);
  const limitParam = `$${values.length}`;

  // One ordered branch per collection, unioned. A single `IN` list makes the
  // planner read every row of the five collections and sort them (measured
  // 8.5 s on the production catalogue); ordered branches let it merge the five
  // index scans and stop after `limit + 1` rows (0.8 ms), because
  // `happyview_records_feed_order_idx` matches this ORDER BY exactly — see
  // 0020-feed-popfeed.sql.
  const POPFEED_PAGED = new Set([POPFEED_REVIEW_COLLECTION, POPFEED_LIST_ITEM_COLLECTION]);
  const unioned = branches.map(({ collection, filter }, index) => {
    const collectionParam = `$${index + 1}`;

    // A personalized Popfeed branch keys on the viewer's dids, and the planner
    // will not use a did-leading index under `did = ANY(...)`: it keeps the
    // time-ordered partial index and walks it looking for the handful of rows
    // those dids wrote (measured 1.4 s for 4 rows). Find which of the viewer's
    // dids have any row for this branch, so iterate the viewer's dids and take
    // the page per did: a did with no rows costs one index descent on
    // (collection, did), and a did with rows stops at its own LIMIT.
    if (dids !== null && POPFEED_PAGED.has(collection)) {
      const filterR = filter.replaceAll('record::jsonb', 'r.record::jsonb');
      const feedTimeR = FEED_TIME.replaceAll('record::jsonb', 'r.record::jsonb');
      let cursorR = '';
      if (cursorParams !== null) {
        cursorR = ` AND (
          CASE WHEN ${cursorParams.time}::text IS NULL
            THEN ${feedTimeR} IS NULL AND r.uri < ${cursorParams.uri}
            ELSE ${feedTimeR} IS NULL
              OR ${feedTimeR} < ${cursorParams.time}
              OR (${feedTimeR} = ${cursorParams.time} AND r.uri < ${cursorParams.uri})
          END
        )`;
      }
      return `(SELECT s.uri, s.collection, s.record, s.created_at, s.hive_id
                 FROM unnest(${didParam}::text[]) AS a(did)
                 CROSS JOIN LATERAL (
                   SELECT r.uri,
                          r.collection,
                          r.record::jsonb AS record,
                          ${feedTimeR} AS created_at,
                          r.record::jsonb->>'hiveId' AS hive_id
                     FROM happyview.happyview_records r
                    WHERE r.collection = ${collectionParam}${filterR}
                      AND r.did = a.did${cursorR}
                    ORDER BY ${feedTimeR} DESC NULLS LAST, r.uri DESC
                    LIMIT ${limitParam}) AS s)`;
    }

    let branch = `(SELECT uri,
                            collection,
                            record::jsonb AS record,
                            ${FEED_TIME} AS created_at,
                            record::jsonb->>'hiveId' AS hive_id
                      FROM happyview.happyview_records
                      WHERE collection = ${collectionParam}${filter}`;
    if (didParam !== null) branch += ` AND did = ANY(${didParam}::text[])`;
    if (cursorParams !== null) {
      branch += ` AND (
        CASE WHEN ${cursorParams.time}::text IS NULL
          THEN ${FEED_TIME} IS NULL AND uri < ${cursorParams.uri}
          ELSE ${FEED_TIME} IS NULL
            OR ${FEED_TIME} < ${cursorParams.time}
            OR (${FEED_TIME} = ${cursorParams.time} AND uri < ${cursorParams.uri})
        END
      )`;
    }
    return `${branch} ORDER BY ${FEED_TIME} DESC NULLS LAST, uri DESC LIMIT ${limitParam})`;
  });

  // A Bookhive record names no edition: `appview_bookhive_lua` resolves its
  // `hiveId` to the edition the catalog import minted, and that edition is the
  // entry's reason. A row whose hive id is not imported yet still feeds (the
  // reason keeps its `bookhive:<shelf>` prefix). Materialised so the lookup runs
  // for the emitted page only, never as a join input the sorted scan has to
  // walk.
  //
  // One edition per hive id, because the lookup cannot be a plain join: the
  // view is `edition_identifiers` filtered to `bookhive.buzz`, keyed
  // `(edition_uri, issuer, value)`, so one `bk_…` may name several editions —
  // the import mints one per catalog book and a re-import mints another — and
  // joining it row-for-row emitted the same post once per edition. `min()` is
  // the deterministic pick; grouping over the page's own hive ids costs a
  // handful of index lookups, not a scan of the view.
  //
  // `DISTINCT ON (uri)` is the skeleton's contract: a page never repeats a
  // `post`. A repeat is not a second entry — the client keys its rows by it —
  // and both the extra editions above and an index that holds a record twice
  // collapse here, before the page is cut to length.
  //
  // A Popfeed record names no edition at all — it carries `identifiers`
  // (`isbn13`/`isbn10`/`asin`) — so the edition comes from a join on
  // `public.edition_identifiers (issuer, value)`, one index lookup per
  // identifier over the page's own Popfeed rows. `min()` is the same
  // deterministic pick as the Bookhive branch above, and both CTEs are grouped
  // by their key so neither can fan a page row out.
  const sql = `WITH page AS MATERIALIZED (
                 ${unioned.join('\n                 UNION ALL\n                 ')}
               ), mapped AS (
                 SELECT p.hive_id, min(m.edition_uri) AS edition_uri
                   FROM page p
                   JOIN public.appview_bookhive_lua m ON m.hive_id = p.hive_id
                  GROUP BY p.hive_id
               ), popfeed_keys AS (
                 SELECT p.uri, k.issuer, k.value
                   FROM page p
                   CROSS JOIN LATERAL (VALUES
                     ('isbn13', p.record->'identifiers'->>'isbn13'),
                     ('isbn10', p.record->'identifiers'->>'isbn10'),
                     ('asin',   p.record->'identifiers'->>'asin')
                   ) AS k(issuer, value)
                  WHERE p.collection IN ('${POPFEED_REVIEW_COLLECTION}', '${POPFEED_LIST_ITEM_COLLECTION}')
                    AND k.value IS NOT NULL
               ), popfeed AS (
                 SELECT k.uri, min(e.edition_uri) AS edition_uri
                   FROM popfeed_keys k
                   JOIN public.edition_identifiers e ON e.issuer = k.issuer AND e.value = k.value
                  GROUP BY k.uri
               ), joined AS (
                 SELECT p.uri, p.collection, p.record, p.created_at,
                        COALESCE(mapped.edition_uri, f.edition_uri) AS book_uri
                   FROM page p
                   LEFT JOIN mapped ON mapped.hive_id = p.hive_id
                   LEFT JOIN popfeed f ON f.uri = p.uri
               ), distinct_posts AS (
                 SELECT DISTINCT ON (uri) uri, collection, record, created_at, book_uri
                   FROM joined
                  ORDER BY uri, created_at DESC NULLS LAST
               )
               SELECT uri, collection, record, created_at, book_uri
                 FROM distinct_posts
                ORDER BY created_at DESC NULLS LAST, uri DESC
                LIMIT ${limitParam}`;

  const pageStarted = performance.now();
  const result = await pool.query(sql, values);
  options.observe?.({
    event: 'page',
    kind: options.kind,
    durationSeconds: (performance.now() - pageStarted) / 1000
  });
  // One row per `post`, before the page is cut: the SQL says the same, and this
  // keeps the contract here so a future change to the query cannot hand a
  // client a page that repeats an entry it keys by. The probe row is counted
  // after the collapse, so a duplicate never masquerades as "there is more".
  const seen = new Set<string>();
  const distinct: FeedRow[] = [];
  for (const raw of result.rows) {
    const row = asFeedRow(raw);
    if (row === null || seen.has(row.uri)) continue;
    seen.add(row.uri);
    distinct.push(row);
  }

  const rows = distinct.slice(0, options.limit);
  const feed = rows.map((row) => {
    const item: FeedSkeletonItem = { post: row.uri };
    const reason = reasonFor(row.collection, row.record, row.book_uri);
    if (reason !== undefined) item.reason = reason;
    return item;
  });

  const last = rows.at(-1);
  const page: FeedSkeleton = { feed };
  if (distinct.length > options.limit && last) {
    page.cursor = encodeCursor({ c: last.created_at, u: last.uri });
  }
  return page;
}
