import { eq, and } from 'drizzle-orm';
import { db, schema } from './db/connection.js';

const { claims } = schema;

export async function canEditBook(did: string, bookUri: string): Promise<boolean> {
  const claim = await db.query.claims.findFirst({
    where: and(eq(claims.bookUri, bookUri), eq(claims.status, 'verified')),
  });

  if (claim && claim.claimedBy === did) return true;

  if (await isLibrarian(did)) return true;

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

async function isLibrarian(did: string): Promise<boolean> {
  // TODO: integrate with labeler service
  // For now, check if any verified claim exists by this DID for other books
  const count = await db.$count(claims, and(
    eq(claims.claimedBy, did),
    eq(claims.status, 'verified')
  ));
  return count > 0;
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
