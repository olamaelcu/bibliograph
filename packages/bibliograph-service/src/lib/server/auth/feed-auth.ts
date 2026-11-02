// Feed authentication module for ATProto feed generator endpoints.
// Uses @atcute/xrpc-server/auth ServiceJwtVerifier to validate JWT bearer tokens.
//
// The verifier resolves the *issuer's* DID document to find the signing key.
// Two kinds of token verify here:
//
//   * Bibliograph's own — minted by the publisher DID, which is what the static
//     feeds use;
//   * a user's — minted by the user's PDS through
//     `com.atproto.server.getServiceAuth` with `aud=<publisher>#atproto_feed` and
//     `lxm=com.atproto.feed.getFeedSkeleton`. Livtet requests the matching
//     `rpc:` grant, so a signed-in reader arrives as a verified DID. This is
//     the only way a foreign caller can name a viewer; see
//     `viewerDidFromRequest` for the cookie fallback used by the storefront.
//
// Issuer documents come from the shared caching resolver: a verified request
// costs one plc.directory fetch per TTL, not one per request. Each `(iss, jti)`
// is recorded so a token cannot be replayed inside its validity window.

import { ServiceJwtVerifier } from '@atcute/xrpc-server/auth';
import type { ReplayStore } from '@atcute/xrpc-server/auth';
import { AuthRequiredError } from '@atcute/xrpc-server';
import type { DidDocumentResolver } from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons/syntax';
import type { Nsid } from '@atcute/lexicons';
import { PUBLISHER_DID } from '../did';
import { didDocumentResolver } from '../did-document-resolver';
import { createLogger } from '../logger';
import { createInMemoryReplayStore } from './replay-store';

const log = createLogger('feed-auth');

/** The publisher DID and the `#atproto_feed` service reference pointing at it. */
const ACCEPT_AUDIENCES = [
  PUBLISHER_DID as Did,
  `${PUBLISHER_DID}#atproto_feed` as `${Did}#${string}`,
];

const FEED_SKELETON_LXM = 'com.atproto.feed.getFeedSkeleton' as const;

export interface FeedAuthOptions {
  /** Overrides the shared resolver; tests use a document for a fixture key. */
  resolver?: DidDocumentResolver;
  /** Overrides the module-wide replay store. */
  replayStore?: ReplayStore;
}

/**
 * Builds a verifier. A factory rather than a module constant so a test can pair
 * it with a resolver serving a throwaway signing key.
 */
export function createFeedAuthVerifier(
  options: FeedAuthOptions = {},
): ServiceJwtVerifier {
  return new ServiceJwtVerifier({
    acceptAudiences: ACCEPT_AUDIENCES,
    resolver: options.resolver ?? didDocumentResolver,
    // Rejects a token whose `exp` is further out, or whose `iat` is further
    // back, than this — the PDS caps a minted token at one hour and defaults
    // to 60 seconds.
    maxAge: 300,
    replayStore: options.replayStore ?? createInMemoryReplayStore(),
  });
}

let verifier: ServiceJwtVerifier | null = null;

function getVerifier(): ServiceJwtVerifier {
  verifier ??= createFeedAuthVerifier();
  return verifier;
}

/**
 * Optional auth: returns the verified issuer, or null when the request carries
 * no usable token. `lxm` binds the accepted token to the endpoint being called,
 * so a token minted for the feed skeleton cannot drive a follow.
 */
export async function verifyFeedAuth(
  request: Request,
  lxm: Nsid = FEED_SKELETON_LXM,
): Promise<string | null> {
  try {
    const v = getVerifier();
    const result = await v.verifyRequest(request, {
      lxm,
    });
    return result.issuer;
  } catch (err) {
    // Missing or invalid Authorization header -> optional auth returns null
    if (err instanceof AuthRequiredError) {
      return null;
    }
    if (err && typeof err === 'object' && 'error' in err && err.error === 'AuthenticationRequired') {
      return null;
    }
    log.warn({ err }, 'feed-auth: unexpected verification error');
    return null;
  }
}

/**
 * Required-auth variant. The verifier's own `AuthRequiredError` is allowed to
 * escape, because it carries the precise reason in the challenge
 * (`WWW-Authenticate: Bearer error="JwtExpired"`); re-wrapping it would reduce
 * every failure to a bare 401.
 */
export async function requireFeedAuth(request: Request): Promise<string> {
  const result = await getVerifier().verifyRequest(request, {
    lxm: FEED_SKELETON_LXM,
  });
  return result.issuer;
}
