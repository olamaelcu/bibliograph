import { eq, and } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
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

const SERVICE_DID = process.env.ATP_SERVICE_DID ?? 'did:web:localhost';

let _verifier: ServiceJwtVerifier | null = null;

function getVerifier(): ServiceJwtVerifier {
  if (!_verifier) {
    _verifier = new ServiceJwtVerifier({
      acceptAudiences: [SERVICE_DID as never, `${SERVICE_DID}#atproto_pds` as never],
      resolver: new CompositeDidDocumentResolver({
        methods: {
          plc: new PlcDidDocumentResolver(),
          web: new WebDidDocumentResolver(),
        },
      }),
    });
  }
  return _verifier;
}

/**
 * Verify ATProto service JWT and return the issuer DID.
 * Throws { status: 401, error: 'AuthenticationRequired' } on failure.
 * Constructs a synthetic Request from the provided headers for the verifier.
 */
export async function requireAuth(headers: Headers, lxm: string): Promise<string> {
  const auth = headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw { status: 401, error: 'AuthenticationRequired', message: 'Missing or invalid authorization' };
  }

  try {
    // verifyRequest expects a Request object so it can parse the header and
    // forward request.signal for DID resolution cancellation.
    const req = new Request('http://localhost', { headers });
    const result = await getVerifier().verifyRequest(req, { lxm: lxm as never });
    return result.issuer;
  } catch (err) {
    logger.warn({ err }, 'JWT verification failed');
    throw { status: 401, error: 'AuthenticationRequired', message: 'Invalid token' };
  }
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
