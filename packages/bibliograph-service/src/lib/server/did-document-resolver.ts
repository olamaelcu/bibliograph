// One DID-document resolver for the whole process.
//
// Two callers need to turn a DID into its document: the PDS read path
// (`pds/resolve.ts`, for `#atproto_pds`) and the inter-service JWT verifier
// (`auth/feed-auth.ts`, for `#atproto`). They share this instance so a `did:plc`
// identity is fetched from plc.directory once per TTL instead of once per call —
// the verifier resolves the issuer on *every* authenticated request, and the
// `@atcute` resolvers cache nothing themselves.
//
// `noCache` must be honoured: when a signature fails against a cached key
// `ServiceJwtVerifier` retries with `noCache: true`, which is how a rotated
// signing key gets picked up. Failures are cached too — a forged or unknown
// `iss` must not be able to drive an outbound fetch on every replay.

import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from '@atcute/identity-resolver';
import type { DidDocumentResolver } from '@atcute/identity-resolver';
import { getDidDocument, PUBLISHER_DID } from './did';
import { createLogger } from './logger';

const log = createLogger('did-document-resolver');

const CACHE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

/** What `DidDocumentResolver.resolve` hands back (the library owns the type). */
type ResolvedDidDocument = Awaited<ReturnType<DidDocumentResolver['resolve']>>;

interface CacheEntry {
  /** `null` is a negative entry: resolution failed inside the TTL window. */
  document: ResolvedDidDocument | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * PLC directory origin. Defaults to the public registry; a local stack points
 * this at the mock PLC so its DIDs resolve without touching the network.
 */
export function plcDirectoryUrl(): string {
  const configured = process.env.PLC_DIRECTORY_URL?.trim();
  return configured ? configured.replace(/\/+$/, '') : 'https://plc.directory';
}

const networkResolver: DidDocumentResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver({ apiUrl: plcDirectoryUrl() }),
    web: new WebDidDocumentResolver(),
  },
});

function remember(
  did: string,
  document: ResolvedDidDocument | null,
  ttlMs: number,
): void {
  if (!cache.has(did) && cache.size >= MAX_ENTRIES) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(did, { document, expiresAt: Date.now() + ttlMs });
}

export const didDocumentResolver: DidDocumentResolver = {
  async resolve(did, options) {
    // Our own identity is served from memory: no network round trip, and it
    // works in a local dev environment whose `did:web` host is not public.
    // `did.ts` hand-rolls the document shape; the verifier only reads `id` and
    // `verificationMethod`, which match.
    if (did === PUBLISHER_DID) {
      return getDidDocument() as unknown as ResolvedDidDocument;
    }

    if (!options?.noCache) {
      const cached = cache.get(did);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.document === null) {
          throw new Error(`DID document resolution failed earlier: ${did}`);
        }
        return cached.document;
      }
    }

    try {
      const document = await networkResolver.resolve(did, options);
      remember(did, document, CACHE_TTL_MS);
      return document;
    } catch (err) {
      remember(did, null, NEGATIVE_TTL_MS);
      log.warn({ err, did }, 'DID document resolution failed');
      throw err;
    }
  },
};

/** For tests: drop every cached document, positive and negative. */
export function clearDidDocumentCache(): void {
  cache.clear();
}
