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

type FeedRow = { uri: string; collection: string; record: unknown; created_at: string | null };

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
 * A review names its edition in `subjectRecord`, else in the first `atproto`
 * identifier of its inline `subject`; a bookStatus names it in `book.uri`.
 */
export function reasonFor(collection: string, record: unknown): string | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;

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
    created_at: typeof value.created_at === 'string' ? value.created_at : null
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
 * Page the two activity collections newest first by the record's own
 * `createdAt`, then `uri` descending. `limit + 1` rows decide whether another
 * page exists; the cursor is built from the last emitted row.
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

  const values: unknown[] = [REVIEW_COLLECTION, BOOK_STATUS_COLLECTION];
  let sql = `SELECT uri,
                    collection,
                    record::jsonb AS record,
                    record::jsonb->>'createdAt' AS created_at
               FROM happyview.happyview_records
              WHERE collection IN ($1, $2)`;

  if (dids !== null) {
    values.push(dids);
    sql += ` AND did = ANY($${values.length}::text[])`;
  }

  if (options.cursor) {
    values.push(options.cursor.c, options.cursor.u);
    const c = `$${values.length - 1}`;
    const u = `$${values.length}`;
    sql += ` AND (
      CASE WHEN ${c}::text IS NULL
        THEN record::jsonb->>'createdAt' IS NULL AND uri < ${u}
        ELSE record::jsonb->>'createdAt' IS NULL
          OR record::jsonb->>'createdAt' < ${c}
          OR (record::jsonb->>'createdAt' = ${c} AND uri < ${u})
      END
    )`;
  }

  values.push(options.limit + 1);
  sql += ` ORDER BY record::jsonb->>'createdAt' DESC NULLS LAST, uri DESC LIMIT $${values.length}`;

  const pageStarted = performance.now();
  const result = await pool.query(sql, values);
  options.observe?.({
    event: 'page',
    kind: options.kind,
    durationSeconds: (performance.now() - pageStarted) / 1000
  });
  const rows = result.rows
    .map(asFeedRow)
    .filter((row): row is FeedRow => row !== null)
    .slice(0, options.limit);

  const feed = rows.map((row) => {
    const item: FeedSkeletonItem = { post: row.uri };
    const reason = reasonFor(row.collection, row.record);
    if (reason !== undefined) item.reason = reason;
    return item;
  });

  const last = rows.at(-1);
  const page: FeedSkeleton = { feed };
  if (result.rows.length > options.limit && last) {
    page.cursor = encodeCursor({ c: last.created_at, u: last.uri });
  }
  return page;
}
