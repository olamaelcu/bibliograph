import { logger } from '../logger.js';
import { cacheGet, cacheSet } from './cache.js';
import {
  CONSTELLATION_URL,
  NETWORK_CACHE_TTL_MS,
  USER_AGENT,
} from './config.js';
import { safeFetchJson } from './safe.js';

export interface BskyEngagement {
  likeCount: number;
  quoteCount: number;
}

interface CountResponse {
  total?: number;
}

/**
 * Fetch public Bluesky engagement (likes + quote-posts) for a single at-uri.
 * Returns undefined on any failure (network error, non-2xx, parse error).
 * Results cached per (subject, source) for NETWORK_CACHE_TTL_MS.
 */
export async function getEngagementForSubject(
  subject: string,
): Promise<BskyEngagement | undefined> {
  const [likes, quotes] = await Promise.all([
    fetchCount(subject, 'app.bsky.feed.like:subject'),
    fetchCount(subject, 'app.bsky.feed.post:embed.record.uri'),
  ]);
  if (likes === null || quotes === null) return undefined;
  return { likeCount: likes, quoteCount: quotes };
}

async function fetchCount(
  subject: string,
  source: string,
): Promise<number | null> {
  const key = `${source}::${subject}`;
  const cached = cacheGet<number>(key);
  if (cached !== undefined) return cached;

  const url = new URL(`${CONSTELLATION_URL}/xrpc/blue.microcosm.links.getBacklinksCount`);
  url.searchParams.set('subject', subject);
  url.searchParams.set('source', source);

  const result = await safeFetchJson<CountResponse>(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (result === null) return null;
  const count = result.total ?? 0;
  cacheSet(key, count, NETWORK_CACHE_TTL_MS);
  return count;
}