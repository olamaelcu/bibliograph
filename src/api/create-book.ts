import type { Context } from 'hono';
import { eq, and, or } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { requireAuth, canCreateBook, isLibrarian } from '../auth.js';
import { publishLabel, negateLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from '../labeler.js';
import { HttpError } from '../errors.js';
import { OpenLibraryProvider } from '../providers/openlibrary.js';
import type { CreateBookInput, CreateReviewInput, CreateStatusInput, CreateClaimInput } from '../types.js';

const { books, reviews, readingStatuses, claims } = schema;

function extractIdentifier(bookUri: string): { type: 'isbn'; value: string } | { type: 'olid'; value: string } | null {
  const urnMatch = bookUri.match(/^urn:isbn:(.+)$/);
  if (urnMatch) return { type: 'isbn', value: urnMatch[1] };

  const olidMatch = bookUri.match(/^(OL\d+[A-Z])$/);
  if (olidMatch) return { type: 'olid', value: olidMatch[1] };

  const bareIsbn = bookUri.match(/^[\d]{9,13}[\dX]$/);
  if (bareIsbn) return { type: 'isbn', value: bookUri };

  const dashedIsbn = bookUri.match(/^[\d-]{10,17}$/);
  if (dashedIsbn) return { type: 'isbn', value: bookUri };

  return null;
}

async function resolveBookUri(did: string, bookUri: string, log: import('pino').Logger): Promise<string | null> {
  if (bookUri.startsWith('at://')) {
    const book = await db.query.books.findFirst({ where: eq(books.uri, bookUri) });
    return book ? book.uri : null;
  }

  const ident = extractIdentifier(bookUri);
  if (!ident) return null;

  if (ident.type === 'isbn') {
    const existing = await db.query.books.findFirst({ where: eq(books.isbn, ident.value) });
    if (existing) return existing.uri;

    log.info({ isbn: ident.value }, 'book not in db, discovering from OpenLibrary');
    const provider = new OpenLibraryProvider();
    const data = await provider.searchByIsbn(ident.value);
    if (!data) return null;

    const isbn = data.isbn13 || data.isbn10 || ident.value;
    const now = new Date().toISOString();
    const rkey = generateRkey();
    const uri = `at://${did}/community.lexicon.book.book/${rkey}`;

    await db.insert(books).values({
      uri,
      did,
      title: data.title,
      author: data.author,
      isbn,
      publishedDate: data.publishedDate,
      description: data.description,
      pageCount: data.pageCount,
      language: data.language,
      categories: data.categories || [],
      identifiers: Object.entries(data.identifiers).map(([type, value]) => ({ type, value })),
      coverUrl: data.coverUrl,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const claimUri = `at://${did}/community.lexicon.book.claim/${rkey}`;
    await db.insert(claims).values({
      uri: claimUri,
      did,
      bookUri: uri,
      identifier: isbn,
      identifierType: 'isbn',
      claimedBy: did,
      status: 'pending',
      createdAt: now,
    });

    log.info({ isbn, uri }, 'book discovered and created');
    return uri;
  }

  if (ident.type === 'olid') {
    const existing = await db.query.books.findFirst({
      where: or(
        eq(books.isbn, ident.value),
        eq(books.uri, ident.value),
      ),
    });
    if (existing) return existing.uri;

    log.info({ olid: ident.value }, 'book not in db, discovering by OLID');
    const provider = new OpenLibraryProvider();
    const data = await provider.getBookDetails(ident.value);
    if (!data) return null;

    const now = new Date().toISOString();
    const rkey = generateRkey();
    const uri = `at://${did}/community.lexicon.book.book/${rkey}`;

    await db.insert(books).values({
      uri,
      did,
      title: data.title,
      author: data.author,
      isbn: data.isbn13 || data.isbn10 || undefined,
      publishedDate: data.publishedDate,
      description: data.description,
      pageCount: data.pageCount,
      language: data.language,
      categories: data.categories || [],
      identifiers: Object.entries(data.identifiers).map(([type, value]) => ({ type, value })),
      coverUrl: data.coverUrl,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    log.info({ olid: ident.value, uri }, 'book discovered and created');
    return uri;
  }

  return null;
}

export async function createBook(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.createBook');
  const input = await c.req.json<CreateBookInput>();

  if (!input.title || !input.author) {
    log.warn({ did, title: input.title, author: input.author }, 'createBook rejected: missing title or author');
    return c.json({ error: 'InvalidInput', message: 'title and author are required' }, 400);
  }

  if (!input.isbn) {
    log.warn({ did, title: input.title }, 'createBook rejected: missing isbn');
    return c.json({ error: 'InvalidInput', message: 'isbn (or EAN/other identifier) is required for deduplication' }, 400);
  }

  log.info({ did, title: input.title, isbn: input.isbn }, 'handling createBook');

  const canCreate = await canCreateBook(did, input.isbn);
  if (!canCreate) {
    log.warn({ did, isbn: input.isbn, title: input.title }, 'createBook rejected: already claimed by another author');
    return c.json({ error: 'Forbidden', message: 'Book already claimed by another author' }, 403);
  }

  const existingBook = await db.query.books.findFirst({
    where: eq(books.isbn, input.isbn),
  });

  if (existingBook) {
    log.warn({ did, isbn: input.isbn, existingUri: existingBook.uri }, 'createBook rejected: duplicate isbn');
    return c.json({ error: 'DuplicateBook', message: 'A book with this ISBN already exists' }, 409);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();

  const bookUri = `at://${did}/community.lexicon.book.book/${rkey}`;

  try {
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
  } catch (err) {
    log.error({ err, did, uri: bookUri, title: input.title, isbn: input.isbn }, 'createBook insert failed');
    throw err;
  }

  const claimUri = `at://${did}/community.lexicon.book.claim/${rkey}`;

  try {
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
  } catch (err) {
    log.error({ err, did, claimUri, bookUri }, 'createBook claim insert failed');
    throw err;
  }

  log.info({ uri: bookUri }, 'createBook complete');
  return c.json({ uri: bookUri, cid: `bafyrei-${rkey}` });
}

export async function createReview(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.createReview');
  const input = await c.req.json<CreateReviewInput>();

  if (!input.bookUri || !input.text) {
    const missing: string[] = [];
    if (!input.bookUri) missing.push('bookUri');
    if (!input.text) missing.push('text');
    log.warn({ did, missing }, 'createReview rejected: missing required fields');
    return c.json({ error: 'InvalidInput', message: 'Missing required fields', missing }, 400);
  }

  log.info({ did, bookUri: input.bookUri }, 'handling createReview');

  let book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    const resolvedUri = await resolveBookUri(did, input.bookUri, log);
    if (resolvedUri) {
      input.bookUri = resolvedUri;
      book = await db.query.books.findFirst({ where: eq(books.uri, resolvedUri) });
    }
  }
  if (!book) {
    log.warn({ did, bookUri: input.bookUri }, 'createReview rejected: book not found');
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.review/${rkey}`;

  try {
    await db.insert(reviews).values({
      uri,
      did,
      bookUri: input.bookUri,
      text: input.text,
      rating: input.rating,
      bookTitle: book.title,
      bookAuthor: book.author,
      createdAt: now,
    });
  } catch (err) {
    log.error({ err, did, bookUri: input.bookUri, uri }, 'createReview insert failed');
    throw err;
  }

  log.info({ uri }, 'createReview complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createStatus(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.createStatus');
  const input = await c.req.json<CreateStatusInput>();

  if (!input.bookUri || !input.status) {
    const missing: string[] = [];
    if (!input.bookUri) missing.push('bookUri');
    if (!input.status) missing.push('status');
    log.warn({ did, missing }, 'createStatus rejected: missing required fields');
    return c.json({ error: 'InvalidInput', message: 'Missing required fields', missing }, 400);
  }

  log.info({ did, bookUri: input.bookUri, status: input.status, progress: input.progress, rating: input.rating }, 'handling createStatus');

  let book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    const resolvedUri = await resolveBookUri(did, input.bookUri, log);
    if (resolvedUri) {
      input.bookUri = resolvedUri;
      book = await db.query.books.findFirst({ where: eq(books.uri, resolvedUri) });
    }
  }
  if (!book) {
    log.warn({ did, bookUri: input.bookUri }, 'createStatus rejected: book not found');
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.status/${rkey}`;

  try {
    await db.insert(readingStatuses).values({
      uri,
      did,
      bookUri: input.bookUri,
      status: input.status,
      progress: input.progress,
      rating: input.rating,
      bookTitle: book.title,
      bookAuthor: book.author,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      createdAt: now,
    });
  } catch (err) {
    log.error({ err, did, bookUri: input.bookUri, status: input.status, uri }, 'createStatus insert failed');
    throw err;
  }

  log.info({ uri }, 'createStatus complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function createClaim(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.createClaim');
  const input = await c.req.json<CreateClaimInput>();

  if (!input.bookUri || !input.identifier || !input.identifierType) {
    const missing: string[] = [];
    if (!input.bookUri) missing.push('bookUri');
    if (!input.identifier) missing.push('identifier');
    if (!input.identifierType) missing.push('identifierType');
    log.warn({ did, missing }, 'createClaim rejected: missing required fields');
    return c.json({ error: 'InvalidInput', message: 'Missing required fields', missing }, 400);
  }

  log.info({ did, bookUri: input.bookUri, identifierType: input.identifierType }, 'handling createClaim');

  const book = await db.query.books.findFirst({ where: eq(books.uri, input.bookUri) });
  if (!book) {
    log.warn({ did, bookUri: input.bookUri }, 'createClaim rejected: book not found');
    return c.json({ error: 'BookNotFound', message: 'Book not found' }, 404);
  }

  const existingClaim = await db.query.claims.findFirst({
    where: and(eq(claims.bookUri, input.bookUri), eq(claims.status, 'verified')),
  });

  if (existingClaim && existingClaim.claimedBy !== did) {
    log.warn({ did, bookUri: input.bookUri, existingClaimedBy: existingClaim.claimedBy }, 'createClaim rejected: already claimed by another author');
    return c.json({ error: 'ClaimAlreadyExists', message: 'This book is already claimed by another author' }, 409);
  }

  const now = new Date().toISOString();
  const rkey = generateRkey();
  const uri = `at://${did}/community.lexicon.book.claim/${rkey}`;

  try {
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
  } catch (err) {
    log.error({ err, did, bookUri: input.bookUri, identifierType: input.identifierType, uri }, 'createClaim insert failed');
    throw err;
  }

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
    throw new HttpError(403, 'Forbidden', 'Librarian privileges required');
  }
}

export async function verifyClaim(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.verifyClaim');
  requireLibrarian(did);

  const { claimUri } = await c.req.json<{ claimUri: string }>();
  if (!claimUri) {
    log.warn({ did }, 'verifyClaim rejected: missing claimUri');
    return c.json({ error: 'InvalidInput', message: 'claimUri is required' }, 400);
  }

  log.info({ did, claimUri }, 'handling verifyClaim');

  const claim = await db.query.claims.findFirst({ where: eq(claims.uri, claimUri) });
  if (!claim) {
    log.warn({ did, claimUri }, 'verifyClaim rejected: claim not found');
    return c.json({ error: 'NotFound', message: 'Claim not found' }, 404);
  }
  if (claim.status === 'verified') {
    log.warn({ did, claimUri, bookUri: claim.bookUri }, 'verifyClaim rejected: already verified');
    return c.json({ error: 'AlreadyVerified', message: 'Claim is already verified' }, 409);
  }

  const now = new Date().toISOString();

  try {
    await db.update(claims)
      .set({ status: 'verified', verifiedBy: did, verifiedAt: now })
      .where(eq(claims.uri, claimUri));
  } catch (err) {
    log.error({ err, did, claimUri }, 'verifyClaim claim update failed');
    throw err;
  }

  try {
    await db.update(schema.books)
      .set({ status: 'active', updatedAt: now })
      .where(eq(schema.books.uri, claim.bookUri));
  } catch (err) {
    log.error({ err, did, claimUri, bookUri: claim.bookUri }, 'verifyClaim book update failed');
    throw err;
  }

  publishLabel(SERVICE_DID, LABEL_AUTHOR, claim.bookUri);

  log.info({ bookUri: claim.bookUri }, 'verifyClaim complete');
  return c.json({ ok: true, bookUri: claim.bookUri, claimedBy: claim.claimedBy });
}

export async function appointLibrarian(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.appointLibrarian');
  requireLibrarian(did);

  const { targetDid } = await c.req.json<{ targetDid: string }>();
  if (!targetDid) {
    log.warn({ did }, 'appointLibrarian rejected: missing targetDid');
    return c.json({ error: 'InvalidInput', message: 'targetDid is required' }, 400);
  }

  log.info({ did, targetDid }, 'handling appointLibrarian');

  try {
    publishLabel(SERVICE_DID, LABEL_LIBRARIAN, targetDid);
  } catch (err) {
    log.error({ err, did, targetDid }, 'appointLibrarian publishLabel failed');
    throw err;
  }

  log.info({ targetDid }, 'appointLibrarian complete');
  return c.json({ ok: true, librarian: targetDid });
}

export async function revokeLibrarian(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(c.req.raw.headers, 'community.lexicon.book.revokeLibrarian');
  requireLibrarian(did);

  const { targetDid } = await c.req.json<{ targetDid: string }>();
  if (!targetDid) {
    log.warn({ did }, 'revokeLibrarian rejected: missing targetDid');
    return c.json({ error: 'InvalidInput', message: 'targetDid is required' }, 400);
  }

  log.info({ did, targetDid }, 'handling revokeLibrarian');

  try {
    negateLabel(SERVICE_DID, LABEL_LIBRARIAN, targetDid);
  } catch (err) {
    log.error({ err, did, targetDid }, 'revokeLibrarian negateLabel failed');
    throw err;
  }

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
