import type { Context } from 'hono';
import { eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { searchBooks } from '../db/init.js';
import type { GetBookParams, GetBooksParams, GetReviewsParams, GetUserStatusParams, SearchBooksParams, GetClaimsParams } from '../types.js';

const { books, reviews, readingStatuses, claims } = schema;

export async function getBook(c: Context): Promise<Response> {
  const params = c.req.query() as unknown as GetBookParams;
  if (!params.uri) return c.json({ error: 'InvalidRequest', message: 'uri is required' }, 400);

  const book = await db.query.books.findFirst({ where: eq(books.uri, params.uri) });
  if (!book) return c.json({ error: 'NotFound', message: 'Book not found' }, 404);

  return c.json({
    uri: book.uri,
    record: serializeBookRecord(book),
    cid: undefined,
  });
}

export async function getBooks(c: Context): Promise<Response> {
  const uris = c.req.queries('uris');
  if (!uris?.length) return c.json({ error: 'InvalidRequest', message: 'uris is required' }, 400);

  const results = await db.query.books.findMany({
    where: (fields, { inArray }) => inArray(fields.uri, uris),
    limit: 25,
  });

  return c.json({
    books: results.map(book => ({
      uri: book.uri,
      record: serializeBookRecord(book),
      cid: undefined,
    })),
  });
}

export async function getReviews(c: Context): Promise<Response> {
  const { bookUri, cursor, limit = '50' } = c.req.query();
  if (!bookUri) return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

  const results = await db.query.reviews.findMany({
    where: eq(reviews.bookUri, bookUri),
    orderBy: (reviews, { desc }) => [desc(reviews.createdAt)],
    limit: lim,
    offset,
  });

  const nextCursor = results.length === lim ? String(offset + lim) : undefined;

  return c.json({
    reviews: results.map(r => ({
      uri: r.uri,
      did: r.did,
      record: {
        $type: 'community.lexicon.book.review',
        bookUri: r.bookUri,
        text: r.text,
        rating: r.rating,
        createdAt: r.createdAt,
      },
    })),
    cursor: nextCursor,
  });
}

export async function getUserStatus(c: Context): Promise<Response> {
  const { did, bookUri, status, cursor, limit = '50' } = c.req.query();
  if (!did) return c.json({ error: 'InvalidRequest', message: 'did is required' }, 400);

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

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
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        createdAt: s.createdAt,
      },
    })),
    cursor: nextCursor,
  });
}

export async function searchBooksHandler(c: Context): Promise<Response> {
  const { q, limit = '20', cursor } = c.req.query();
  if (!q) return c.json({ error: 'InvalidRequest', message: 'q is required' }, 400);

  const lim = Math.min(Math.max(1, parseInt(limit as string) || 20), 100);
  const offset = cursor ? parseInt(cursor as string) : 0;

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
  const { bookUri } = c.req.query();
  if (!bookUri) return c.json({ error: 'InvalidRequest', message: 'bookUri is required' }, 400);

  const results = await db.query.claims.findMany({
    where: eq(claims.bookUri, bookUri),
    orderBy: (claims, { desc }) => [desc(claims.createdAt)],
  });

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
    status: book.status,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}
