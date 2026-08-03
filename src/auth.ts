import { eq, and } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { HttpError } from './errors.js';
import { hasLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from './labeler.js';
import { logger } from './logger.js';
import {
  ServiceJwtVerifier,
} from '@atcute/xrpc-server/auth';
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from '@atcute/identity-resolver';

const { claims } = schema;

function decodeJwt(token: string) {
  const parts = token.split('.');
  return {
    parts: parts.length,
    header: tryDecodePart(parts[0]),
    payload: tryDecodePart(parts[1]),
  };
}

function tryDecodePart(encoded: string | undefined) {
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return encoded.slice(0, 50);
  }
}

const SERVICE_DID = process.env.ATP_SERVICE_DID ?? 'did:web:localhost';

let _resolver: any = null;

function getResolver() {
  if (!_resolver) {
    _resolver = new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver(),
        web: new WebDidDocumentResolver(),
      },
    });
  }
  return _resolver;
}

function audiencesFromHeaders(headers: Headers): string[] {
  const hosts = new Set<string>();
  if (SERVICE_DID) hosts.add(SERVICE_DID);
  const host = headers.get('host');
  if (host) {
    hosts.add(`did:web:${host}`);
    hosts.add(`did:web:${encodeURIComponent(host)}`);
    hosts.add(`did:web:${decodeURIComponent(host)}`);
  }
  return [...hosts];
}

export async function requireAuth(headers: Headers, lxm: string): Promise<string> {
  const auth = headers.get('authorization');
  logger.debug({ auth, lxm }, 'requireAuth called');
  if (!auth) {
    logger.warn('authorization header missing');
    throw new HttpError(401, 'AuthenticationRequired', 'Missing authorization header');
  }
  if (!auth.startsWith('Bearer ')) {
    logger.warn({ scheme: auth.split(' ')[0] || auth }, 'authorization header present but not Bearer');
    throw new HttpError(401, 'AuthenticationRequired', 'Authorization header must use Bearer scheme');
  }

  const token = auth.slice(7);
  if (!token) {
    logger.warn('bearer token is empty');
    throw new HttpError(401, 'AuthenticationRequired', 'Empty bearer token');
  }

  try {
    const audiences = audiencesFromHeaders(headers);
    const verifier = new ServiceJwtVerifier({
      acceptAudiences: audiences as never,
      resolver: getResolver(),
    });
    const req = new Request('http://localhost', { headers });
    const result = await verifier.verifyRequest(req, { lxm: lxm as never });
    logger.info({ did: result.issuer, lxm, audiences }, 'JWT verified');
    return result.issuer;
  } catch (err) {
    logger.warn({ err, token: decodeJwt(token) }, 'JWT verification failed');
    throw new HttpError(401, 'AuthenticationRequired', 'Invalid token');
  }
}

export async function optionalAuth(headers: Headers, lxm: string): Promise<string | undefined> {
  const auth = headers.get('authorization');
  if (!auth) return undefined;
  return requireAuth(headers, lxm);
}

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

export function isLibrarian(did: string): boolean {
  return hasLabel(did, LABEL_LIBRARIAN);
}

export function isAuthorOf(did: string, bookUri: string): boolean {
  return hasLabel(bookUri, LABEL_AUTHOR, did);
}
