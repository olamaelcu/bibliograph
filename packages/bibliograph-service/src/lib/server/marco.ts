import type { Logger } from 'pino';

// marco (https://marco.jazco.dev) — the network follow/block graph as a
// read-only, fire-and-forget annotation source. Calls are one Connect-JSON
// POST each; every failure logs a warn and is swallowed, so a marco outage
// degrades the annotation (never the page). Disabled by setting `MARCO_URL`
// to the empty string; defaults to the public instance.
//
// EDGE PRIVACY: this shares (viewer DID, candidate DID) pairs with whatever
// MARCO_URL points at. Pointing production at the public instance is an
// explicit operational decision — set MARCO_URL='' to opt out.

const DEFAULT_MARCO_URL = 'https://marco.jazco.dev';
// This host measures 200-360 ms cold; 800 leaves headroom without holding a
// feed hostage on a slow marco. Overridden by MARCO_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.MARCO_TIMEOUT_MS ?? 800);

function marcoBaseUrl(): string | null {
  const raw = process.env.MARCO_URL;
  if (raw !== undefined && raw.trim() === '') return null;
  return (raw && raw.trim()) || DEFAULT_MARCO_URL;
}

interface RelationshipsResponse {
  relationships?: Array<{
    other?: string;
    rels?: Array<{ rel?: string; outUri?: string; inUri?: string }>;
  }>;
}

interface IntersectResponse {
  actors?: string[];
}

async function marcoCall<T>(method: string, body: unknown, log: Logger): Promise<T | null> {
  const base = marcoBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/marco.v1.Graph/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ method, status: res.status, stage: 'marco' }, 'marco call failed; annotation skipped');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn({ err, method, stage: 'marco' }, 'marco call failed; annotation skipped');
    return null;
  }
}

/**
 * Which of `others` the viewer blocks, or which block the viewer — for
 * filtering authors out of viewer-facing surfaces. Empty set on any failure,
 * so callers filter nothing when marco is down.
 */
export async function blockedAmong(
  viewerDid: string,
  others: readonly string[],
  log: Logger,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (!viewerDid.startsWith('did:') || others.length === 0 || !marcoBaseUrl()) return blocked;
  // `Relationships` takes at most 100 others per call.
  for (let i = 0; i < others.length; i += 100) {
    const chunk = others.slice(i, i + 100);
    const out = await marcoCall<RelationshipsResponse>(
      'Relationships',
      { actor: viewerDid, others: chunk },
      log,
    );
    for (const other of out?.relationships ?? []) {
      // marco always names the default relations (follow, block) even when no
      // record exists — an edge exists only when the entry carries a URI.
      const block = other.rels?.find((rel) => rel.rel === 'block');
      if (block && (block.outUri || block.inUri) && other.other) blocked.add(other.other);
    }
  }
  return blocked;
}

/** The viewer's mutual follows on the network. Cached 5 minutes per viewer. */
const mutualCache = new Map<string, { mutuals: string[]; expiresAt: number }>();

export async function mutualsFor(viewerDid: string, log: Logger): Promise<string[]> {
  if (!viewerDid.startsWith('did:') || !marcoBaseUrl()) return [];
  const hit = mutualCache.get(viewerDid);
  if (hit && hit.expiresAt > Date.now()) return hit.mutuals;
  const out = await marcoCall<IntersectResponse>(
    'Intersect',
    {
      a: { rel: 'follow', dir: 'DIR_OUT', actor: viewerDid },
      b: { rel: 'follow', dir: 'DIR_IN', actor: viewerDid },
    },
    log,
  );
  // `null` is a failure, distinct from "0 mutuals": only cache a real answer.
  if (out === null) return [];
  const mutuals = (out.actors ?? [])
    .filter((did): did is string => typeof did === 'string' && did.startsWith('did:'))
    .slice(0, 256);
  if (mutualCache.size >= 512) {
    const oldest = mutualCache.keys().next();
    if (!oldest.done) mutualCache.delete(oldest.value);
  }
  mutualCache.set(viewerDid, { mutuals, expiresAt: Date.now() + 300_000 });
  return mutuals;
}

/** Test seam: the mutual cache lives for the process. */
export function _resetMarcoCacheForTesting(): void {
  mutualCache.clear();
}
