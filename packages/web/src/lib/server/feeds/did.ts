import type { DidDocument, DidResolver } from './auth';

/**
 * DID document resolution for feed service-JWT verification.
 *
 * `did:plc` is read from the configured PLC directory (`PLC_URL`, which the
 * caller supplies; there is no default); `did:web` follows the method spec. The
 * result is cached briefly because a feed page verifies one token, and a
 * caller retrying a page should not re-fetch the same document.
 */

export type DidResolverOptions = {
  plcUrl: string;
  fetchImpl?: typeof fetch;
  /** Positive cache lifetime. */
  ttlMs?: number;
  /** Cache lifetime for a DID that resolved to nothing. */
  negativeTtlMs?: number;
  timeoutMs?: number;
};

const MAX_CACHE_ENTRIES = 512;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The document URL for a `did:web`, or `null` for an invalid identifier. */
export function didWebDocumentUrl(did: string): string | null {
  const rest = did.slice('did:web:'.length);
  if (rest === '') return null;
  const [rawHost, ...rawPath] = rest.split(':');
  const host = safeDecode(rawHost ?? '');
  if (host === null || host === '') return null;
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) && !/^\[[0-9A-Fa-f:]+\](?::\d+)?$/.test(host)) {
    return null;
  }

  const segments: string[] = [];
  for (const raw of rawPath) {
    const segment = safeDecode(raw);
    if (segment === null || segment === '' || segment === '.' || segment === '..') return null;
    if (segment.includes('/')) return null;
    segments.push(segment);
  }
  return segments.length === 0
    ? `https://${host}/.well-known/did.json`
    : `https://${host}/${segments.join('/')}/did.json`;
}

function documentUrl(did: string, plcUrl: string): string | null {
  if (did.startsWith('did:plc:')) {
    if (!/^did:plc:[a-z0-9]+$/.test(did)) return null;
    return `${plcUrl.replace(/\/+$/, '')}/${did}`;
  }
  if (did.startsWith('did:web:')) return didWebDocumentUrl(did);
  return null;
}

export function createDidResolver(options: DidResolverOptions): DidResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const negativeTtlMs = options.negativeTtlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;

  type Entry = { value: Promise<DidDocument | null>; expiresAt: number };
  const cache = new Map<string, Entry>();

  async function fetchDocument(did: string): Promise<DidDocument | null> {
    const url = documentUrl(did, options.plcUrl);
    if (url === null) return null;
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/did+ld+json, application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) return null;
      const document: unknown = await response.json();
      if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        return null;
      }
      return document as DidDocument;
    } catch {
      return null;
    }
  }

  return (did) => {
    const now = Date.now();
    const cached = cache.get(did);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = fetchDocument(did);
    const entry: Entry = { value, expiresAt: now + ttlMs };
    cache.set(did, entry);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    // Immutable in the map, so shortening a negative result is safe.
    void value.then((document) => {
      if (document === null) entry.expiresAt = Date.now() + negativeTtlMs;
    });
    return value;
  };
}
