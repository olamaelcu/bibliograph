import { verifySignature } from '@atproto/crypto';

/**
 * Service-JWT authentication for the personalized feeds.
 *
 * atproto feed generators receive a short-lived service JWT minted by the
 * caller's PDS: `Authorization: Bearer <jwt>`, signed by the account whose
 * `did` appears in `iss`, with `aud` naming this generator and `lxm` naming
 * `com.atproto.feed.getFeedSkeleton`. The signature is verified against the
 * `#atproto` Multikey of the issuer's DID document, never against a caller
 * supplied DID header: `x-viewer-did` is ignored on purpose.
 */

export type DidVerificationMethod = {
  id?: string;
  type?: string;
  controller?: string;
  publicKeyMultibase?: string;
};

export type DidDocument = {
  id?: string;
  verificationMethod?: DidVerificationMethod[];
};

export type DidResolver = (did: string) => Promise<DidDocument | null>;

export type VerifyFeedJwtOptions = {
  /** Exact `aud` this generator accepts, `<did>#atproto_feed`. */
  audience: string;
  /** Resolves the issuer DID document. */
  resolveDid: DidResolver;
  /** Current time in seconds; injectable for tests. */
  now?: number;
};

/** Bounded reason codes so the edge can label rejections without parsing messages. */
export const FEED_AUTH_REASONS = ['format', 'claims', 'expired', 'issuer', 'signature'] as const;
export type FeedAuthReason = (typeof FEED_AUTH_REASONS)[number];

/** Every rejection is a `401`; the message says what failed without leaking crypto detail. */
export class FeedAuthError extends Error {
  readonly reason: FeedAuthReason;

  constructor(reason: FeedAuthReason, message: string) {
    super(message);
    this.name = 'FeedAuthError';
    this.reason = reason;
  }
}

export const FEED_SKELETON_LXM = 'com.atproto.feed.getFeedSkeleton';

const ALLOWED_ALGS: Record<string, true> = { ES256K: true, ES256: true };
// Service tokens are valid for about a minute; a longer lifetime is not a
// service-auth token and should not be honoured here.
const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

type JwtHeader = { alg?: unknown; typ?: unknown };
type JwtPayload = {
  iss?: unknown;
  aud?: unknown;
  lxm?: unknown;
  exp?: unknown;
  iat?: unknown;
};

function decodeBase64Url(value: string): Uint8Array | null {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[a-z0-9]+:[^\s]+$/i.test(value) && value.length <= 2048;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Verify one atproto service JWT and return the issuing DID.
 *
 * Rejections throw `FeedAuthError`. A DID document that cannot be resolved is
 * a rejection too: an unknown signer cannot be trusted.
 */
export async function verifyFeedServiceJwt(
  token: string,
  options: VerifyFeedJwtOptions
): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new FeedAuthError('format', 'the service token is not a compact JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const headerBytes = decodeBase64Url(encodedHeader);
  const payloadBytes = decodeBase64Url(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!headerBytes || !payloadBytes || !signature) {
    throw new FeedAuthError('format', 'the service token is not base64url encoded');
  }

  const header = decodeJsonObject(headerBytes) as JwtHeader | null;
  const payload = decodeJsonObject(payloadBytes) as JwtPayload | null;
  if (!header || !payload) {
    throw new FeedAuthError('format', 'the service token is not valid JSON');
  }

  if (typeof header.alg !== 'string' || ALLOWED_ALGS[header.alg] !== true) {
    throw new FeedAuthError('claims', 'the service token uses an unsupported algorithm');
  }
  if (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt') {
    throw new FeedAuthError('claims', 'the service token has an unsupported type');
  }

  const { iss, aud, lxm, exp, iat } = payload;
  if (!isDid(iss)) throw new FeedAuthError('claims', 'the service token issuer is not a DID');
  if (aud !== options.audience) {
    throw new FeedAuthError('claims', 'the service token audience is not this feed generator');
  }
  if (lxm !== FEED_SKELETON_LXM) {
    throw new FeedAuthError(
      'claims',
      'the service token is not for com.atproto.feed.getFeedSkeleton'
    );
  }
  if (!isInteger(exp) || !isInteger(iat)) {
    throw new FeedAuthError('claims', 'the service token has no integer exp/iat');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (exp <= now) throw new FeedAuthError('expired', 'the service token has expired');
  if (iat > now + CLOCK_SKEW_SECONDS) {
    throw new FeedAuthError('expired', 'the service token was issued in the future');
  }
  if (exp <= iat) {
    throw new FeedAuthError('expired', 'the service token expires before it was issued');
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new FeedAuthError('expired', 'the service token lifetime is too long');
  }

  let document: DidDocument | null;
  try {
    document = await options.resolveDid(iss);
  } catch {
    throw new FeedAuthError('issuer', 'the service token issuer could not be resolved');
  }
  if (!document || typeof document !== 'object') {
    throw new FeedAuthError('issuer', 'the service token issuer could not be resolved');
  }

  const method = Array.isArray(document.verificationMethod)
    ? document.verificationMethod.find(
        (entry) => entry !== null && typeof entry === 'object' && entry.id === `${iss}#atproto`
      )
    : undefined;
  if (!method) {
    throw new FeedAuthError('issuer', 'the issuer has no #atproto verification method');
  }
  if (method.type !== 'Multikey' || typeof method.publicKeyMultibase !== 'string') {
    throw new FeedAuthError('issuer', 'the issuer #atproto key is not a Multikey');
  }
  if (method.controller !== undefined && method.controller !== iss) {
    throw new FeedAuthError('issuer', 'the issuer #atproto key is controlled by another DID');
  }

  // `verifySignature` hashes with SHA-256, expects a compact `r || s` ECDSA
  // signature, rejects malleable high-S signatures, and checks that the key's
  // algorithm matches `jwtAlg`.
  let valid = false;
  try {
    valid = await verifySignature(
      `did:key:${method.publicKeyMultibase}`,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      signature,
      { jwtAlg: header.alg }
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new FeedAuthError('signature', 'the service token signature does not verify');

  return iss;
}
