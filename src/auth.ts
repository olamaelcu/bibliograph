import { eq, and } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { hasLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from './labeler.js';

const { claims } = schema;

/**
 * A DID can edit a book if:
 * 1. They are the verified claim owner
 * 2. They hold the book:librarian label
 */
export async function canEditBook(did: string, bookUri: string): Promise<boolean> {
  const claim = await db.query.claims.findFirst({
    where: and(eq(claims.bookUri, bookUri), eq(claims.status, 'verified')),
  });

  if (claim && claim.claimedBy === did) return true;

  if (isLibrarian(did)) return true;

  return false;
}

export async function canCreateBook(did: string, isbn: string): Promise<boolean> {
  const existing = await db.query.claims.findFirst({
    where: and(eq(claims.identifier, isbn), eq(claims.status, 'verified')),
  });

  if (!existing) return true;

  return existing.claimedBy === did;
}

export async function canClaimBook(did: string, bookUri: string): Promise<boolean> {
  const existing = await db.query.claims.findFirst({
    where: eq(claims.bookUri, bookUri),
  });

  if (!existing) return true;

  return isLibrarian(did);
}

/**
 * Check if a DID holds the book:librarian label.
 */
export function isLibrarian(did: string): boolean {
  return hasLabel(did, LABEL_LIBRARIAN);
}

/**
 * Check if a DID is the verified author of a specific book.
 */
export function isAuthorOf(did: string, bookUri: string): boolean {
  return hasLabel(bookUri, LABEL_AUTHOR, did);
}

export function requireAuth(headers: Headers): string {
  const auth = headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw { status: 401, error: 'AuthenticationRequired', message: 'Missing or invalid authorization' };
  }
  // In production, verify JWT here. For now, extract DID from token.
  // The actual JWT verification depends on @atcute/xrpc-server's auth.
  return auth.slice(7);
}
