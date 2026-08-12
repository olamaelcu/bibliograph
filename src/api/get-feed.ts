import type { Context } from 'hono';
import { desc, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { optionalAuth } from '../auth.js';
import { isFeatureEnabled } from '../features.js';
import { FollowsService } from '../services/follows.js';
import type { BookRef, FeedRecentItem, FeedWindow } from '../types.js';

const { books, reviews, readingStatuses } = schema;

const NSID = 'community.lexicon.book.feed';
const WINDOWS: Record<FeedWindow, number> = { day: 24, week: 7 * 24, month: 30 * 24 };
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

const followsService = new FollowsService();

interface RecentRow {
  type: 'review' | 'status';
  did: string;
  uri: string;
  bookUri: string;
  bookTitle: string;
  bookAuthor: string;
  createdAt: string;
}

interface BookCountRow {
  bookUri: string;
  bookTitle: string;
  bookAuthor: string;
  users: number;
  latest: string;
}

function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw || '');
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, parsed), MAX_LIMIT);
}

function toBookRef(bookUri: string, title: string, author: string): BookRef {
  return { uri: bookUri, title, author };
}

// ─── Cursor (keyset pagination on `recent` only) ───────────────────────────

function encodeCursor(createdAt: string, uri: string): string {
  return Buffer.from(JSON.stringify({ createdAt, uri })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: string; uri: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: string; uri?: string };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.uri !== 'string') return undefined;
    return { createdAt: parsed.createdAt, uri: parsed.uri };
  } catch {
    return undefined;
  }
}

// ─── Bucket queries ─────────────────────────────────────────────────────────

function queryRecent(limit: number, cursor: string | undefined): { items: FeedRecentItem[]; cursor: string | undefined } {
  const key = decodeCursor(cursor);
  const rows = db.all(sql`
    SELECT * FROM (
      SELECT 'review' AS type, did, uri, bookUri, book_title AS bookTitle, book_author AS bookAuthor, createdAt
      FROM reviews
      UNION ALL
      SELECT 'status' AS type, did, uri, bookUri, book_title AS bookTitle, book_author AS bookAuthor, createdAt
      FROM reading_statuses
    )
    ${key ? sql`WHERE (createdAt < ${key.createdAt} OR (createdAt = ${key.createdAt} AND uri < ${key.uri}))` : sql``}
    ORDER BY createdAt DESC, uri DESC
    LIMIT ${limit}
  `) as unknown as RecentRow[];

  const items = rows.map((r) => ({
    type: r.type,
    did: r.did,
    uri: r.uri,
    book: toBookRef(r.bookUri, r.bookTitle, r.bookAuthor),
    createdAt: r.createdAt,
  }));

  const next = items.length === limit ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].uri) : undefined;
  return { items, cursor: next };
}

function queryNewestBooks(limit: number): BookRef[] {
  const rows = db.select({
    uri: books.uri,
    title: books.title,
    author: books.author,
  })
    .from(books)
    .where(ne(books.status, 'rejected'))
    .orderBy(desc(books.createdAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({ uri: r.uri, title: r.title, author: r.author }));
}

function queryTrending(windowStart: string, limit: number): BookRef[] {
  const rows = db.all(sql`
    SELECT bookUri, bookTitle, bookAuthor, COUNT(DISTINCT did) AS users, MAX(createdAt) AS latest
    FROM (
      SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
      FROM reviews WHERE createdAt >= ${windowStart}
      UNION ALL
      SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
      FROM reading_statuses WHERE createdAt >= ${windowStart}
    )
    GROUP BY bookUri, bookTitle, bookAuthor
    ORDER BY users DESC, latest DESC
    LIMIT ${limit}
  `) as unknown as BookCountRow[];

  return rows.map((r) => toBookRef(r.bookUri, r.bookTitle, r.bookAuthor));
}

function queryFollowing(followedDids: string[], limit: number): BookRef[] {
  if (followedDids.length === 0) return [];
  const dids = sql.join(followedDids.map((d) => sql`${d}`), sql`, `);
  const rows = db.all(sql`
    SELECT bookUri, bookTitle, bookAuthor, MAX(createdAt) AS latest
    FROM (
      SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
      FROM reviews WHERE did IN (${dids})
      UNION ALL
      SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
      FROM reading_statuses WHERE did IN (${dids})
    )
    GROUP BY bookUri, bookTitle, bookAuthor
    ORDER BY latest DESC
    LIMIT ${limit}
  `) as unknown as Array<{ bookUri: string; bookTitle: string; bookAuthor: string }>;

  return rows.map((r) => toBookRef(r.bookUri, r.bookTitle, r.bookAuthor));
}

function queryCrossUser(viewerDid: string, windowStart: string, limit: number): BookRef[] {
  const rows = db.all(sql`
    SELECT bookUri, bookTitle, bookAuthor, latest
    FROM (
      SELECT bookUri, bookTitle, bookAuthor, MAX(createdAt) AS latest
      FROM (
        SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
        FROM reviews
        WHERE createdAt >= ${windowStart} AND bookUri IN (
          SELECT bookUri FROM reviews WHERE did = ${viewerDid} AND createdAt >= ${windowStart}
          UNION
          SELECT bookUri FROM reading_statuses WHERE did = ${viewerDid} AND createdAt >= ${windowStart}
        )
        UNION ALL
        SELECT bookUri, book_title AS bookTitle, book_author AS bookAuthor, did, createdAt
        FROM reading_statuses
        WHERE createdAt >= ${windowStart} AND bookUri IN (
          SELECT bookUri FROM reviews WHERE did = ${viewerDid} AND createdAt >= ${windowStart}
          UNION
          SELECT bookUri FROM reading_statuses WHERE did = ${viewerDid} AND createdAt >= ${windowStart}
        )
      )
      WHERE did != ${viewerDid}
      GROUP BY bookUri, bookTitle, bookAuthor
    )
    ORDER BY latest DESC
    LIMIT ${limit}
  `) as unknown as Array<{ bookUri: string; bookTitle: string; bookAuthor: string }>;

  return rows.map((r) => toBookRef(r.bookUri, r.bookTitle, r.bookAuthor));
}

function windowStart(window: FeedWindow): string {
  return new Date(Date.now() - WINDOWS[window] * 60 * 60 * 1000).toISOString();
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function getFeed(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;

  if (!isFeatureEnabled('feedGenerator')) {
    log.warn('getFeed rejected: feature feedGenerator disabled');
    return c.json({ error: 'InvalidRequest', message: 'feature feedGenerator disabled' }, 404);
  }

  const { limit, cursor } = c.req.query();
  const lim = parseLimit(limit);

  log.info({ limit: lim, hasCursor: !!cursor }, 'handling getFeed');

  let viewerDid: string | undefined;
  try {
    viewerDid = await optionalAuth(c.req.raw.headers, NSID);
  } catch (err) {
    log.warn({ err }, 'getFeed rejected: invalid token');
    throw err;
  }

  const { items: recent, cursor: nextCursor } = queryRecent(lim, cursor);
  const newestBooks = queryNewestBooks(lim);
  const trending = {
    day: queryTrending(windowStart('day'), lim),
    week: queryTrending(windowStart('week'), lim),
    month: queryTrending(windowStart('month'), lim),
  };

  let following: BookRef[] | undefined;
  let crossUser: Record<FeedWindow, BookRef[]> | undefined;
  let degraded: boolean | undefined;

  if (viewerDid) {
    let followedDids: string[];
    try {
      followedDids = await followsService.getFollows(viewerDid);
    } catch (err) {
      log.warn({ err, viewerDid }, 'getFeed: follows fetch failed, degrading following bucket');
      followedDids = [];
      degraded = true;
    }
    following = queryFollowing(followedDids, lim);
    crossUser = {
      day: queryCrossUser(viewerDid, windowStart('day'), lim),
      week: queryCrossUser(viewerDid, windowStart('week'), lim),
      month: queryCrossUser(viewerDid, windowStart('month'), lim),
    };
  }

  log.info({ recent: recent.length, hasCursor: !!nextCursor }, 'getFeed complete');
  return c.json({
    recent,
    newestBooks,
    trending,
    following,
    crossUser,
    degraded,
    cursor: nextCursor,
  });
}
