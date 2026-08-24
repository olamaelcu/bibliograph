// Resolve a user's PDS endpoint and run authenticated XRPC reads against it.
//
// Bibliograph's user-record procedures (getActorProfile, getReadingGoal,
// listShelvingForDid, etc.) need to read records the user wrote to their OWN
// PDS. This module is the foundation for those reads:
//
//   1. resolvePds(did)  — looks up the user's DID document, finds the
//      `#atproto_pds` service endpoint, returns the base URL.
//   2. pdsClient(pdsUrl) — returns an atcute Client bound to that PDS,
//      ready for anonymous record reads against public collections.
//
// Authenticated reads (where a collection is ACL'd and needs a service-auth
// JWT) are not yet wired here; that's a follow-up. The default `simpleFetchHandler`
// performs anonymous reads. ReadingGoal `current` may be ACL'd on some PDSes —
// those PDSes will return 401 and the caller should surface the appropriate
// Bibliograph-side error.
//
// Caching is intentionally minimal: a short in-memory Map keyed by DID, with
// a small TTL. The DID document rarely changes (PLC rotations invalidate it,
// which we don't try to detect here). For high-traffic deployments, swap for
// an LRU with a longer TTL.

import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  LocalActorResolver,
  WellKnownHandleResolver,
  XrpcHandleResolver,
} from '@atcute/identity-resolver';
import { Client, simpleFetchHandler } from '@atcute/client';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  pds: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const didResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

const handleResolver = new WellKnownHandleResolver();
// Fallback to the bsky.app XRPC handle resolver when well-known isn't available.
const fallbackHandleResolver = new XrpcHandleResolver({ serviceUrl: 'https://public.api.bsky.app' });

const actorResolver = new LocalActorResolver({
  didDocumentResolver: didResolver,
  handleResolver: {
    async resolve(handle, opts) {
      try {
        return await handleResolver.resolve(handle, opts);
      } catch {
        return fallbackHandleResolver.resolve(handle, opts);
      }
    },
  },
});

export async function resolvePds(actor: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const cached = cache.get(actor);
  if (cached && cached.expiresAt > Date.now()) return cached.pds;

  // ActorResolver.resolve expects an ActorIdentifier (Did | Handle). The schema
  // for the query parameter is `format: did`, so this is always a DID at the
  // XRPC boundary; the cast is safe given the lex spec.
  const resolved = await actorResolver.resolve(actor as Parameters<typeof actorResolver.resolve>[0], { signal: opts?.signal });
  cache.set(actor, { pds: resolved.pds, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved.pds;
}

export interface PdsClient {
  /** ATProto RPC client bound to the user's PDS for anonymous reads. */
  client: Client;
  /** The PDS base URL the client was bound to. */
  pds: string;
}

/**
 * Returns an atcute Client targeting the user's PDS. Used by procedures that
 * call `com.atproto.repo.{getRecord,listRecords}` (and `sync.getBlob` for
 * images) anonymously. Per-record validation happens inside the handler
 * against the lex schemas.
 */
export async function pdsClient(actor: string, opts?: { signal?: AbortSignal }): Promise<PdsClient> {
  const pds = await resolvePds(actor, opts);
  return {
    pds,
    client: new Client({ handler: simpleFetchHandler({ service: pds }) }),
  };
}

/**
 * Clear the in-memory PDS cache. Useful in tests; not exposed via XRPC.
 */
export function clearPdsCache(): void {
  cache.clear();
}
