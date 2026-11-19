import { verifySignature } from '@atproto/crypto';

/**
 * atproto service-JWT authentication for the edge's authenticated methods.
 *
 * A caller's PDS mints a short-lived service JWT for it: `Authorization: Bearer
 * <jwt>`, signed by the account whose `did` appears in `iss`, with `aud` naming
 * this host's service `did:web` and `lxm` naming the one method it may be used
 * for. The signature is verified against the `#atproto` Multikey of the issuer's
 * DID document, never against a caller-supplied DID header: `x-viewer-did` is
 * ignored on purpose, and so is any other header naming a user.
 *
 * Two methods use it today: the personalized feed skeleton
 * (`com.atproto.feed.getFeedSkeleton`, `aud` = `<did>#atproto_feed`) and the
 * giveaway draw (`net.olamaelcu.livtet.biblio.giveaway.draw`, `aud` = the
 * service `did:web` with no fragment). The audience and the method are both
 * options, so this module holds the rules and each caller pins its own target.
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

export type VerifyServiceAuthOptions = {
  /** Exact `aud` this method accepts. */
  audience: string;
  /** Exact `lxm` this method is bound to; a token for another method is refused. */
  lxm: string;
  /** Resolves the issuer DID document. */
  resolveDid: DidResolver;
  /** Current time in seconds; injectable for tests. */
  now?: number;
};

/** Bounded reason codes so the edge can label rejections without parsing messages. */
export const SERVICE_AUTH_REASONS = [
  'format',
  'claims',
  'expired',
  'issuer',
  'signature'
] as const;
export type ServiceAuthReason = (typeof SERVICE_AUTH_REASONS)[number];

/** Every rejection is a `401`; the message says what failed without leaking crypto detail. */
export class ServiceAuthError extends Error {
  readonly reason: ServiceAuthReason;

  constructor(reason: ServiceAuthReason, message: string) {
    super(message);
    this.name = 'ServiceAuthError';
    this.reason = reason;
  }
}

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
 * Rejections throw `ServiceAuthError`. A DID document that cannot be resolved is
 * a rejection too: an unknown signer cannot be trusted.
 */
export async function verifyServiceAuthJwt(
  token: string,
  options: VerifyServiceAuthOptions
): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ServiceAuthError('format', 'the service token is not a compact JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const headerBytes = decodeBase64Url(encodedHeader);
  const payloadBytes = decodeBase64Url(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!headerBytes || !payloadBytes || !signature) {
    throw new ServiceAuthError('format', 'the service token is not base64url encoded');
  }

  const header = decodeJsonObject(headerBytes) as JwtHeader | null;
  const payload = decodeJsonObject(payloadBytes) as JwtPayload | null;
  if (!header || !payload) {
    throw new ServiceAuthError('format', 'the service token is not valid JSON');
  }

  if (typeof header.alg !== 'string' || ALLOWED_ALGS[header.alg] !== true) {
    throw new ServiceAuthError('claims', 'the service token uses an unsupported algorithm');
  }
  if (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt') {
    throw new ServiceAuthError('claims', 'the service token has an unsupported type');
  }

  const { iss, aud, lxm, exp, iat } = payload;
  if (!isDid(iss)) throw new ServiceAuthError('claims', 'the service token issuer is not a DID');
  if (aud !== options.audience) {
    throw new ServiceAuthError('claims', 'the service token audience is not this service');
  }
  if (lxm !== options.lxm) {
    throw new ServiceAuthError(
      'claims',
      `the service token is not for ${options.lxm}`
    );
  }
  if (!isInteger(exp) || !isInteger(iat)) {
    throw new ServiceAuthError('claims', 'the service token has no integer exp/iat');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (exp <= now) throw new ServiceAuthError('expired', 'the service token has expired');
  if (iat > now + CLOCK_SKEW_SECONDS) {
    throw new ServiceAuthError('expired', 'the service token was issued in the future');
  }
  if (exp <= iat) {
    throw new ServiceAuthError('expired', 'the service token expires before it was issued');
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new ServiceAuthError('expired', 'the service token lifetime is too long');
  }

  let document: DidDocument | null;
  try {
    document = await options.resolveDid(iss);
  } catch {
    throw new ServiceAuthError('issuer', 'the service token issuer could not be resolved');
  }
  if (!document || typeof document !== 'object') {
    throw new ServiceAuthError('issuer', 'the service token issuer could not be resolved');
  }

  const method = Array.isArray(document.verificationMethod)
    ? document.verificationMethod.find(
        (entry) => entry !== null && typeof entry === 'object' && entry.id === `${iss}#atproto`
      )
    : undefined;
  if (!method) {
    throw new ServiceAuthError('issuer', 'the issuer has no #atproto verification method');
  }
  if (method.type !== 'Multikey' || typeof method.publicKeyMultibase !== 'string') {
    throw new ServiceAuthError('issuer', 'the issuer #atproto key is not a Multikey');
  }
  if (method.controller !== undefined && method.controller !== iss) {
    throw new ServiceAuthError('issuer', 'the issuer #atproto key is controlled by another DID');
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
  if (!valid) {
    throw new ServiceAuthError('signature', 'the service token signature does not verify');
  }

  return iss;
}
