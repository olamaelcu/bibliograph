import type { Context } from 'hono';
import { and, eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { getLabels } from '../labeler.js';
import { parsePagination, nextCursor } from '../pagination.js';
import { searchFallback, type FallbackSource } from './search-fallback.js';
import { computeDeduplicationHash } from '../dedup.js';
import type { BookData } from '../providers/interface.js';
import type { GetBookParams, GetBooksParams, GetReviewsParams, GetReviewParams, GetUserStatusParams, SearchBooksParams, GetClaimsParams, GetShelvesParams, GetShelfParams, GetShelfItemsParams } from '../types.js';

const { books, reviews, readingStatuses, claims, shelves, shelfItems } = schema;

export async function getBook(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const params = c.req.query() as unknown as GetBookParams;
  if (!params.uri) {
    log.warn('getBook rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri: params.uri }, 'handling getBook');

  const book = await db.query.books.findFirst({ where: eq(books.uri, params.uri) });
  if (!book) {
    log.info({ found: false }, 'getBook complete');
    return c.json({ error: 'NotFound', message: 'Book not found' }, 404);
  }

  log.info({ found: true }, 'getBook complete');
  return c.json({
    uri: book.uri,
    record: serializeBookRecord(book),
    cid: undefined,
  });
}

export async function getBooks(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const uris = c.req.queries('uris');
  if (!uris?.length) {
    log.warn('getBooks rejected: missing uris');
    return c.json({ error: 'InvalidRequest', message: 'uris is required' }, 400);
  }

  log.info({ count: uris.length }, 'handling getBooks');

  const results = await db.query.books.findMany({
    where: (fields, { inArray }) => inArray(fields.uri, uris),
    limit: 25,
  });

  log.info({ found: results.length }, 'getBooks complete');
  return c.json({
    books: results.map(book => ({
      uri: book.uri,
      record: serializeBookRecord(book),
      cid: undefined,
    })),
  });
}

export async function getReviews(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { bookUri, cursor, limit = '50' } = c.req.query();
  if (!bookUri) {
    log.warn('getReviews rejected: missing bookUri');
    return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ bookUri, limit: lim }, 'handling getReviews');

  const results = await db.query.reviews.findMany({
    where: eq(reviews.bookUri, bookUri),
    orderBy: (reviews, { desc }) => [desc(reviews.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getReviews complete');
  return c.json({
    reviews: results.map(r => ({
      uri: r.uri,
      did: r.did,
      record: {
        $type: 'community.lexicon.book.review',
        bookUri: r.bookUri,
        text: r.text,
        rating: r.rating,
        bookRef: {
          uri: r.bookUri,
          title: r.bookTitle,
          author: r.bookAuthor,
        },
        createdAt: r.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

export async function getReview(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { uri, did, bookUri } = c.req.query();

  let where;
  if (uri) {
    where = eq(reviews.uri, uri);
  } else if (did && bookUri) {
    where = and(eq(reviews.did, did), eq(reviews.bookUri, bookUri));
  } else {
    log.warn('getReview rejected: uri or did+bookUri required');
    return c.json({ error: 'InvalidRequest', message: 'uri or did+bookUri is required' }, 400);
  }

  log.info({ uri, did, bookUri }, 'handling getReview');

  const review = await db.query.reviews.findFirst({ where });
  if (!review) {
    log.info({ found: false }, 'getReview complete');
    return c.json({ error: 'NotFound', message: 'Review not found' }, 404);
  }

  log.info({ found: true }, 'getReview complete');
  return c.json({
    uri: review.uri,
    did: review.did,
    record: {
      $type: 'community.lexicon.book.review',
      bookUri: review.bookUri,
      text: review.text,
      rating: review.rating,
      bookRef: {
        uri: review.bookUri,
        title: review.bookTitle,
        author: review.bookAuthor,
      },
      createdAt: review.createdAt,
    },
    cid: review.cid ?? undefined,
  });
}

export async function getUserStatus(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { did, bookUri, status, cursor, limit = '50' } = c.req.query();
  if (!did) {
    log.warn('getUserStatus rejected: missing did');
    return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ did, bookUri, status, limit: lim }, 'handling getUserStatus');

  const conditions = [eq(readingStatuses.did, did)];
  if (bookUri) conditions.push(eq(readingStatuses.bookUri, bookUri));
  if (status) conditions.push(eq(readingStatuses.status, status));

  const results = await db.query.readingStatuses.findMany({
    where: (fields, { and }) => and(...conditions),
    orderBy: (fields, { desc }) => [desc(fields.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ uris: results.map(s => s.uri), found: results.length }, 'getUserStatus complete');
  return c.json({
    statuses: results.map(s => ({
      uri: s.uri,
      did: s.did,
      bookUri: s.bookUri,
      record: {
        $type: 'community.lexicon.book.status',
        bookUri: s.bookUri,
        status: s.status,
        progress: s.progress,
        rating: s.rating,
        bookRef: {
          uri: s.bookUri,
          title: s.bookTitle,
          author: s.bookAuthor,
        },
        identifiers: typeof s.identifiers === 'string' ? JSON.parse(s.identifiers) : s.identifiers,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        createdAt: s.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

async function findImportedBookRow(book: BookData) {
  const canonical = book.isbn13 || book.isbn10;
  if (canonical) {
    const byIsbn = await db.query.books.findFirst({ where: eq(books.isbn, canonical) });
    if (byIsbn) return byIsbn;
  }
  const dhash = computeDeduplicationHash(book.title, book.author, book.publishedDate);
  if (dhash) {
    const byHash = await db.query.books.findFirst({ where: eq(books.deduplicationHash, dhash) });
    if (byHash) return byHash;
  }
  return null;
}

function providerRecord(book: BookData): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.book',
    title: book.title,
    author: book.author,
    isbn: book.isbn13 || book.isbn10,
    publishedDate: book.publishedDate,
    description: book.description,
    pageCount: book.pageCount,
    language: book.language,
    categories: book.categories || [],
    identifiers: book.identifiers,
    coverUrl: book.coverUrl,
  };
}

interface FallbackEntry {
  uri: string;
  record: Record<string, unknown>;
  source: FallbackSource;
}

async function enrichFallbackBooks(fallbackBooks: BookData[], source: FallbackSource): Promise<FallbackEntry[]> {
  const entries: FallbackEntry[] = [];
  for (const book of fallbackBooks) {
    const row = await findImportedBookRow(book);
    if (row) {
      entries.push({ uri: row.uri, record: providerRecord(book), source });
    }
  }
  return entries;
}

export async function searchBooksHandler(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { q, limit = '20', cursor, identifier, includeUnverified } = c.req.query();
  if (!q && !identifier) {
    log.warn('searchBooks rejected: missing q and identifier');
    return c.json({ error: 'InvalidRequest', message: 'q or identifier is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 20, 100);

  log.info({ q, identifier, limit: lim }, 'handling searchBooksHandler');

  if (identifier) {
    const sanitized = (q as string || '').replace(/['"]/g, '').trim();
    const identifierTypes = (identifier as string).split(',').map(t => t.trim()).filter(Boolean);

    const conditions: ReturnType<typeof sql>[] = [sql`1 = 1`];

    if (sanitized) {
      conditions.push(sql`identifier_value LIKE ${`%${sanitized}%`}`);
    }

    if (identifierTypes.length > 0) {
      conditions.push(
        sql`identifier_type IN (${sql.join(identifierTypes.map(t => sql`${t}`), sql`, `)})`,
      );
    }

    if (includeUnverified !== 'true') {
      conditions.push(sql`claim_status IN ('json', 'verified')`);
    }

    const rows = db.all(
      sql`
        SELECT DISTINCT uri, title, author, isbn, identifier_type, identifier_value, claim_status
        FROM books_identifiers
        WHERE ${and(...conditions)}
        ORDER BY title
        LIMIT ${lim} OFFSET ${offset}
      `,
    ) as Array<{ uri: string; title: string; author: string; isbn: string | null; identifier_type: string; identifier_value: string; claim_status: string }>;

    const bookEntries: Array<Record<string, unknown>> = rows.map(row => ({
      uri: row.uri,
      record: {
        $type: 'community.lexicon.book.book',
        title: row.title,
        author: row.author,
        isbn: row.isbn,
      },
      matchedIdentifier: {
        type: row.identifier_type,
        value: row.identifier_value,
        status: row.claim_status,
      },
    }));

    if (rows.length === 0 && identifierTypes.length === 1 && identifierTypes[0] === 'isbn' && sanitized) {
      const fb = await searchFallback(db, sanitized, log);
      const enriched = await enrichFallbackBooks(fb.books, fb.source);
      for (const entry of enriched) {
        bookEntries.push({
          uri: entry.uri,
          record: entry.record,
          source: entry.source,
        });
      }
    }

    log.info({ found: bookEntries.length }, 'searchBooksHandler complete');
    return c.json({
      books: bookEntries,
      cursor: nextCursor(bookEntries.length, offset, lim),
    });
  }

  const sanitized = (q as string).replace(/['"]/g, '').trim();

  let results;
  if (sanitized.match(/^[0-9-]+$/)) {
    results = await db.query.books.findMany({
      where: or(like(books.isbn, `%${sanitized}%`), like(books.title, `%${sanitized}%`)),
      limit: lim,
      offset,
    });
  } else {
    results = await db.query.books.findMany({
      where: or(like(books.title, `%${sanitized}%`), like(books.author, `%${sanitized}%`)),
      limit: lim,
      offset,
    });
  }

  const bookEntries: Array<{ uri: string; record: Record<string, unknown>; source?: FallbackSource }> = results.map(book => ({
    uri: book.uri,
    record: serializeBookRecord(book),
  }));

  if (results.length === 0 && sanitized) {
    const fb = await searchFallback(db, sanitized, log);
    const enriched = await enrichFallbackBooks(fb.books, fb.source);
    for (const entry of enriched) {
      bookEntries.push({
        uri: entry.uri,
        record: entry.record,
        source: entry.source,
      });
    }
  }

  log.info({ found: bookEntries.length }, 'searchBooksHandler complete');
  return c.json({
    books: bookEntries,
    cursor: nextCursor(bookEntries.length, offset, lim),
    total: bookEntries.length,
  });
}

export async function getClaims(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { bookUri } = c.req.query();
  if (!bookUri) {
    log.warn('getClaims rejected: missing bookUri');
    return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);
  }

  log.info({ bookUri }, 'handling getClaims');

  const results = await db.query.claims.findMany({
    where: eq(claims.bookUri, bookUri),
    orderBy: (claims, { desc }) => [desc(claims.createdAt)],
  });

  log.info({ found: results.length }, 'getClaims complete');
  return c.json({
    claims: results.map(c => ({
      uri: c.uri,
      did: c.did,
      record: {
        $type: 'community.lexicon.book.claim',
        bookUri: c.bookUri,
        identifier: c.identifier,
        identifierType: c.identifierType,
        claimedBy: c.claimedBy,
        status: c.status,
        verifiedBy: c.verifiedBy,
        verifiedAt: c.verifiedAt,
        createdAt: c.createdAt,
      },
    })),
  });
}

function serializeBookRecord(book: typeof books.$inferSelect): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.book',
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    publishedDate: book.publishedDate,
    description: book.description,
    pageCount: book.pageCount,
    language: book.language,
    categories: typeof book.categories === 'string' ? JSON.parse(book.categories) : book.categories,
    identifiers: typeof book.identifiers === 'string' ? JSON.parse(book.identifiers) : book.identifiers,
    coverUrl: book.coverUrl,
    deduplicationHash: book.deduplicationHash,
    status: book.status,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

export async function getShelves(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { did, cursor, limit = '50' } = c.req.query();
  if (!did) {
    log.warn('getShelves rejected: missing did');
    return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ did, limit: lim }, 'handling getShelves');

  const results = await db.query.shelves.findMany({
    where: eq(shelves.did, did),
    orderBy: (shelves, { desc }) => [desc(shelves.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getShelves complete');
  return c.json({
    shelves: results.map(s => ({
      uri: s.uri,
      did: s.did,
      record: serializeShelfRecord(s),
    })),
    cursor: cursorOut,
  });
}

export async function getShelf(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { uri } = c.req.query();
  if (!uri) {
    log.warn('getShelf rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri }, 'handling getShelf');

  const shelf = await db.query.shelves.findFirst({ where: eq(shelves.uri, uri) });
  if (!shelf) {
    log.info({ found: false }, 'getShelf complete');
    return c.json({ error: 'NotFound', message: 'Shelf not found' }, 404);
  }

  log.info({ found: true }, 'getShelf complete');
  return c.json({
    uri: shelf.uri,
    did: shelf.did,
    record: serializeShelfRecord(shelf),
  });
}

export async function getShelfItems(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { shelfUri, cursor, limit = '50' } = c.req.query();
  if (!shelfUri) {
    log.warn('getShelfItems rejected: missing shelfUri');
    return c.json({ error: 'InvalidRequest', message: 'shelfUri is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ shelfUri, limit: lim }, 'handling getShelfItems');

  const results = await db.query.shelfItems.findMany({
    where: eq(shelfItems.shelfUri, shelfUri),
    orderBy: (shelfItems, { desc }) => [desc(shelfItems.createdAt)],
    limit: lim,
    offset,
  });

  const cursorOut = nextCursor(results.length, offset, lim);

  log.info({ found: results.length, hasCursor: !!cursorOut }, 'getShelfItems complete');
  return c.json({
    items: results.map(i => ({
      uri: i.uri,
      did: i.did,
      record: {
        $type: 'community.lexicon.book.shelfItem',
        shelfUri: i.shelfUri,
        bookUri: i.bookUri,
        bookRef: {
          uri: i.bookUri,
          title: i.bookTitle,
          author: i.bookAuthor,
        },
        note: i.note,
        createdAt: i.createdAt,
      },
    })),
    cursor: cursorOut,
  });
}

function serializeShelfRecord(shelf: typeof shelves.$inferSelect): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.shelf',
    name: shelf.name,
    description: shelf.description,
    metadata: typeof shelf.metadata === 'string' ? JSON.parse(shelf.metadata) : shelf.metadata,
    coverUrl: shelf.coverUrl,
    createdAt: shelf.createdAt,
  };
}

export function getLabelerLabels(c: Context): Response {
  const log = c.get('log') as import('pino').Logger;
  const { uri, val } = c.req.query();
  if (!uri) {
    log.warn('getLabelerLabels rejected: missing uri');
    return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);
  }

  log.info({ uri, val }, 'handling getLabelerLabels');

  const labels = getLabels(uri, val || undefined);
  log.info({ found: labels.length }, 'getLabelerLabels complete');
  return c.json({ labels });
}
