import type { Context } from 'hono';
import { eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { getLabels } from '../labeler.js';
import type { GetBookParams, GetBooksParams, GetReviewsParams, GetUserStatusParams, SearchBooksParams, GetClaimsParams } from '../types.js';

const { books, reviews, readingStatuses, claims } = schema;

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

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

  log.info({ bookUri, limit: lim }, 'handling getReviews');

  const results = await db.query.reviews.findMany({
    where: eq(reviews.bookUri, bookUri),
    orderBy: (reviews, { desc }) => [desc(reviews.createdAt)],
    limit: lim,
    offset,
  });

  const nextCursor = results.length === lim ? String(offset + lim) : undefined;

  log.info({ found: results.length, hasCursor: !!nextCursor }, 'getReviews complete');
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
    cursor: nextCursor,
  });
}

export async function getUserStatus(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { did, bookUri, status, cursor, limit = '50' } = c.req.query();
  if (!did) {
    log.warn('getUserStatus rejected: missing did');
    return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);
  }

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

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

  const nextCursor = results.length === lim ? String(offset + lim) : undefined;

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
    cursor: nextCursor,
  });
}

export async function searchBooksHandler(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { q, limit = '20', cursor, identifier, includeUnverified } = c.req.query();
  if (!q && !identifier) {
    log.warn('searchBooks rejected: missing q and identifier');
    return c.json({ error: 'InvalidRequest', message: 'q or identifier is required' }, 400);
  }

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 20), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

  log.info({ q, identifier, limit: lim }, 'handling searchBooksHandler');

  if (identifier) {
    const sanitized = (q as string || '').replace(/['"]/g, '').trim();
    const identifierTypes = (identifier as string).split(',').map(t => t.trim()).filter(Boolean);

    let whereConditions = ['1=1'];

    if (sanitized) {
      whereConditions.push(`identifier_value LIKE '%${sanitized.replace(/'/g, "''")}%'`);
    }

    if (identifierTypes.length > 0) {
      const typesList = identifierTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`identifier_type IN (${typesList})`);
    }

    if (includeUnverified !== 'true') {
      whereConditions.push(`claim_status IN ('json', 'verified')`);
    }

    const whereClause = whereConditions.join(' AND ');

    const rows = db.all(
      `SELECT DISTINCT uri, title, author, isbn, identifier_type, identifier_value, claim_status
       FROM books_identifiers
       WHERE ${whereClause}
       ORDER BY title
       LIMIT ${lim} OFFSET ${offset}`,
    ) as Array<{ uri: string; title: string; author: string; isbn: string | null; identifier_type: string; identifier_value: string; claim_status: string }>;

    log.info({ found: rows.length }, 'searchBooksHandler complete');
    return c.json({
      books: rows.map(row => ({
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
      })),
      cursor: rows.length === lim ? String(offset + lim) : undefined,
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

  log.info({ found: results.length }, 'searchBooksHandler complete');
  return c.json({
    books: results.map(book => ({
      uri: book.uri,
      record: serializeBookRecord(book),
    })),
    cursor: results.length === lim ? String(offset + lim) : undefined,
    total: results.length,
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
