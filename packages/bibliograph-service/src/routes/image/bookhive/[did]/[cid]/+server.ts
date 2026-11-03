// Streams a Bookhive reader's cover blob back to the client.
//
// `getImageForBook` answers with a URL here when a `bh.` edition's catalog
// record carries no cover of its own: the blob belongs to the reader's copy of
// the book, so the bytes live on that reader's PDS and any tile that wants them
// would otherwise have to resolve the DID and call `com.atproto.sync.getBlob`
// itself — per tile, cross-origin, and with no shared cache.

import type { RequestHandler } from './$types';
import { resolvePds } from '$lib/server/pds/resolve';

// A blob is content-addressed: the CID in the URL names exactly these bytes, so
// the response can be cached for good.
const CACHE_CONTROL = 'public, max-age=86400, immutable';
const FETCH_TIMEOUT_MS = 5_000;
// A DID document is a small JSON object; an image blob is not, and 5 MiB is the
// size a PDS caps an image upload at.
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;

// `did:plc:` / `did:web:` and their method-specific ids. The method id may
// contain dots (did:web) and percent escapes, never a slash or a space.
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;
// Base32 CIDv1 (`bafkrei…` for a raw image blob) or base58 CIDv0. Anything else
// is not a CID, and forwarding it would make this route an open proxy.
const CID_RE = /^(?:b[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

interface CachedBlob {
  body: ArrayBuffer;
  contentType: string;
}

const blobs = new Map<string, CachedBlob>();
let cachedBytes = 0;

function cacheGet(key: string): CachedBlob | undefined {
  const hit = blobs.get(key);
  if (!hit) return undefined;
  // Re-insert to mark it as most recently used: Map iterates in insertion order,
  // which is what the eviction below reads as least recently used.
  blobs.delete(key);
  blobs.set(key, hit);
  return hit;
}

function cacheSet(key: string, blob: CachedBlob): void {
  const previous = blobs.get(key);
  if (previous) {
    blobs.delete(key);
    cachedBytes -= previous.body.byteLength;
  }
  blobs.set(key, blob);
  cachedBytes += blob.body.byteLength;
  while (blobs.size > MAX_CACHE_ENTRIES || (cachedBytes > MAX_CACHE_BYTES && blobs.size > 1)) {
    const oldest = blobs.keys().next();
    if (oldest.done) break;
    const evicted = blobs.get(oldest.value);
    blobs.delete(oldest.value);
    cachedBytes -= evicted?.body.byteLength ?? 0;
  }
}

function imageResponse(blob: CachedBlob): Response {
  return new Response(blob.body, {
    headers: {
      'content-type': blob.contentType,
      'content-length': String(blob.body.byteLength),
      'cache-control': CACHE_CONTROL,
      // Covers are rendered by the appview's own clients, not only by a page on
      // this origin.
      'access-control-allow-origin': '*',
    },
  });
}

export const GET: RequestHandler = async ({ params }) => {
  const { did, cid } = params;
  if (!DID_RE.test(did) || !CID_RE.test(cid)) {
    return new Response('not a bookhive blob reference', { status: 400 });
  }

  const key = `${did}/${cid}`;
  const cached = cacheGet(key);
  if (cached) return imageResponse(cached);

  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const pds = await resolvePds(did, { signal });
    const query = `did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
    const upstream = await fetch(`${pds.replace(/\/$/, '')}/xrpc/com.atproto.sync.getBlob?${query}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      // A missing blob and an unreachable PDS are different answers: the first
      // is permanent, the second is worth retrying.
      return new Response(`blob unavailable (${upstream.status})`, { status: upstream.status === 404 ? 404 : 502 });
    }
    const declared = Number(upstream.headers.get('content-length') ?? '0');
    if (declared > MAX_BLOB_BYTES) {
      return new Response('blob too large', { status: 502 });
    }
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BLOB_BYTES) {
      return new Response('blob too large', { status: 502 });
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const blob = { body, contentType };
    cacheSet(key, blob);
    return imageResponse(blob);
  } catch {
    return new Response('blob fetch failed', { status: 502 });
  }
};
