import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { requireAuth, canCreateBook, isLibrarian } from '../auth.js';
import { publishLabel, negateLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from '../labeler.js';
import type { CreateBookInput, CreateReviewInput, CreateStatusInput, CreateClaimInput } from '../types.js';

const { books, reviews, readingStatuses, claims } = schema;

export async function createBook(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateBookInput>();

  if (!input.title || !input.author) {
    return c.json({ error: 'InvalidInput', message: 'title and author are required' }, 400);
  }

  if (!input.isbn) {
    return c.json({ error: 'InvalidInput', message: 'isbn (or EAN/other identifier) is required for deduplication' }, 400);
  }

  log.info({ did, title: input.title, isbn: input.isbn }, 'handling createBook');

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

  log.info({ uri: bookUri }, 'createBook complete');
  return c.json({ uri: bookUri, cid: `bafyrei-${rkey}` });
}

export async function createReview(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateReviewInput>();

  if (!input.bookUri || !input.text) {
    return c.json({ error: 'InvalidInput', message: 'bookUri and text are required' }, 400);
  }

  log.info({ did, bookUri: input.bookUri }, 'handling createReview');

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

  log.info({ uri }, 'createReview complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createStatus(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateStatusInput>();

  if (!input.bookUri || !input.status) {
    return c.json({ error: 'InvalidInput', message: 'bookUri and status are required' }, 400);
  }

  log.info({ did, bookUri: input.bookUri, status: input.status }, 'handling createStatus');

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

  log.info({ uri }, 'createStatus complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createClaim(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  const input = await c.req.json<CreateClaimInput>();

  if (!input.bookUri || !input.identifier || !input.identifierType) {
    return c.json({ error: 'InvalidInput', message: 'bookUri, identifier, and identifierType are required' }, 400);
  }

  log.info({ did, bookUri: input.bookUri, identifierType: input.identifierType }, 'handling createClaim');

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

  log.info({ uri }, 'createClaim complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

/**
 * Reference implementation: label authority is self-contained.
 * The AppView's own DID is used as the label `src`.
 */
const SERVICE_DID = process.env.ATP_SERVICE_DID || 'did:web:localhost';

function requireLibrarian(did: string): void {
  if (!isLibrarian(did)) {
    throw { status: 403, error: 'Forbidden', message: 'Librarian privileges required' };
  }
}

export async function verifyClaim(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  requireLibrarian(did);

  const { claimUri } = await c.req.json<{ claimUri: string }>();
  if (!claimUri) return c.json({ error: 'InvalidInput', message: 'claimUri is required' }, 400);

  log.info({ did, claimUri }, 'handling verifyClaim');

  const claim = await db.query.claims.findFirst({ where: eq(claims.uri, claimUri) });
  if (!claim) return c.json({ error: 'NotFound', message: 'Claim not found' }, 404);
  if (claim.status === 'verified') return c.json({ error: 'AlreadyVerified', message: 'Claim is already verified' }, 409);

  const now = new Date().toISOString();

  await db.update(claims)
    .set({ status: 'verified', verifiedBy: did, verifiedAt: now })
    .where(eq(claims.uri, claimUri));

  await db.update(schema.books)
    .set({ status: 'active', updatedAt: now })
    .where(eq(schema.books.uri, claim.bookUri));

  publishLabel(SERVICE_DID, LABEL_AUTHOR, claim.bookUri);

  log.info({ bookUri: claim.bookUri }, 'verifyClaim complete');
  return c.json({ ok: true, bookUri: claim.bookUri, claimedBy: claim.claimedBy });
}

export async function appointLibrarian(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  requireLibrarian(did);

  const { targetDid } = await c.req.json<{ targetDid: string }>();
  if (!targetDid) return c.json({ error: 'InvalidInput', message: 'targetDid is required' }, 400);

  log.info({ did, targetDid }, 'handling appointLibrarian');

  publishLabel(SERVICE_DID, LABEL_LIBRARIAN, targetDid);

  log.info({ targetDid }, 'appointLibrarian complete');
  return c.json({ ok: true, librarian: targetDid });
}

export async function revokeLibrarian(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = requireAuth(c.req.raw.headers);
  requireLibrarian(did);

  const { targetDid } = await c.req.json<{ targetDid: string }>();
  if (!targetDid) return c.json({ error: 'InvalidInput', message: 'targetDid is required' }, 400);

  log.info({ did, targetDid }, 'handling revokeLibrarian');

  negateLabel(SERVICE_DID, LABEL_LIBRARIAN, targetDid);

  log.info({ targetDid }, 'revokeLibrarian complete');
  return c.json({ ok: true, librarian: targetDid });
}

function generateRkey(): string {
  const chars = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 13; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
