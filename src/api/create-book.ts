import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { requireAuth, canCreateBook } from '../auth.js';
import type { CreateBookInput, CreateReviewInput, CreateStatusInput, CreateClaimInput } from '../types.js';

const { books, reviews, readingStatuses, claims } = schema;

export async function createBook(c: Context): Promise<Response> {
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateBookInput>();

  if (!input.title || !input.author) {
    return c.json({ error: 'InvalidInput', message: 'title and author are required' }, 400);
  }

  if (!input.isbn) {
    return c.json({ error: 'InvalidInput', message: 'isbn (or EAN/other identifier) is required for deduplication' }, 400);
  }

  const canCreate = await canCreateBook(did, input.isbn);
  if (!canCreate) {
    return c.json({ error: 'Forbidden', message: 'Book already claimed by another author' }, 403);
  }

  const existingBook = await db.query.books.findFirst({
    where: eq(books.isbn, input.isbn),
  });

  if (existingBook) {
    return c.json({ error: 'DuplicateBook', message: 'A book with this ISBN already exists' }, 409);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();

  const bookUri = `at://${did}/community.lexicon.book.book/${rkey}`;

  await db.insert(books).values({
    uri: bookUri,
    did,
    title: input.title,
    author: input.author,
    isbn: input.isbn,
    publishedDate: input.publishedDate,
    description: input.description,
    pageCount: input.pageCount,
    language: input.language,
    categories: input.categories || [],
    identifiers: [],
    coverUrl: input.coverUrl,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  const claimUri = `at://${did}/community.lexicon.book.claim/${rkey}`;

  await db.insert(claims).values({
    uri: claimUri,
    did,
    bookUri,
    identifier: input.isbn,
    identifierType: 'isbn',
    claimedBy: did,
    status: 'pending',
    createdAt: now,
  });

  return c.json({ uri: bookUri, cid: `bafyrei-${rkey}` });
}

export async function createReview(c: Context): Promise<Response> {
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateReviewInput>();

  if (!input.bookUri || !input.text) {
    return c.json({ error: 'InvalidInput', message: 'bookUri and text are required' }, 400);
  }

  const book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.review/${rkey}`;

  await db.insert(reviews).values({
    uri,
    did,
    bookUri: input.bookUri,
    text: input.text,
    rating: input.rating,
    createdAt: now,
  });

  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createStatus(c: Context): Promise<Response> {
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateStatusInput>();

  if (!input.bookUri || !input.status) {
    return c.json({ error: 'InvalidInput', message: 'bookUri and status are required' }, 400);
  }

  const book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.status/${rkey}`;

  await db.insert(readingStatuses).values({
    uri,
    did,
    bookUri: input.bookUri,
    status: input.status,
    progress: input.progress,
    rating: input.rating,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    createdAt: now,
  });

  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createClaim(c: Context): Promise<Response> {
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateClaimInput>();

  if (!input.bookUri || !input.identifier || !input.identifierType) {
    return c.json({ error: 'InvalidInput', message: 'bookUri, identifier, and identifierType are required' }, 400);
  }

  const book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const existingClaim = await db.query.claims.findFirst({
    where: and(eq(claims.bookUri, input.bookUri), eq(claims.status, 'verified')),
  });

  if (existingClaim && existingClaim.claimedBy !== did) {
    return c.json({ error: 'ClaimAlreadyExists', message: 'This book is already claimed by another author' }, 409);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.claim/${rkey}`;

  await db.insert(claims).values({
    uri,
    did,
    bookUri: input.bookUri,
    identifier: input.identifier,
    identifierType: input.identifierType,
    claimedBy: did,
    status: 'pending',
    createdAt: now,
  });

  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

function generateRkey(): string {
  const chars = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 13; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
