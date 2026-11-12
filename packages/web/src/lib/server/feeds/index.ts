import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

import { CatalogUnavailableError, catalogPool } from '$lib/server/catalog/db';
import { createDidResolver } from './did';
import { FeedAuthError, verifyFeedServiceJwt, type DidResolver } from './auth';
import {
  FEED_KINDS,
  decodeCursor,
  fetchFeedPage,
  type FeedKind,
  type FeedSkeleton
} from './query';

/**
 * The edge feed generator.
 *
 * Two `com.atproto.feed.*` queries are answered here — describing the feed
 * generator and serving skeletons from `happyview.happyview_records` — so the
 * edge needs no HappyView script and no worker task for feeds. `public` is
 * anonymous; the three personalized feeds require a service JWT whose
 * signature verifies against the issuer's `#atproto` key.
 */

export const FEED_COLLECTION = 'net.olamaelcu.livtet.biblio.feed.generator';
export const DESCRIBE_FEED_GENERATOR = 'com.atproto.feed.describeFeedGenerator';
export const GET_FEED_SKELETON = 'com.atproto.feed.getFeedSkeleton';

const DEFAULT_FEED_GENERATOR_DID = 'did:web:biblio.livtet.olamaelcu.net';
const DEFAULT_PLC_URL = 'https://plc.directory';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ERROR_AUTH_REQUIRED = 'AuthRequired';
const ERROR_INVALID_REQUEST = 'InvalidRequest';
const ERROR_UNAVAILABLE = 'ServiceUnavailable';

export function isFeedMethod(method: string): boolean {
  return method === DESCRIBE_FEED_GENERATOR || method === GET_FEED_SKELETON;
}

export function feedGeneratorDid(): string {
  return env.FEED_GENERATOR_DID ?? DEFAULT_FEED_GENERATOR_DID;
}

function feedUri(did: string, kind: FeedKind): string {
  return `at://${did}/${FEED_COLLECTION}/${kind}`;
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, { status });
}

/** Strict parse: a foreign DID, wrong collection or unknown kind is not a feed. */
function parseFeedUri(feed: string, did: string): FeedKind | null {
  const prefix = `at://${did}/${FEED_COLLECTION}/`;
  if (!feed.startsWith(prefix)) return null;
  const kind = feed.slice(prefix.length);
  return FEED_KINDS.find((candidate) => candidate === kind) ?? null;
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  return Math.min(MAX_LIMIT, Math.max(1, Number(raw)));
}

function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

let resolverCache: { plcUrl: string; resolve: DidResolver } | undefined;

function didResolver(): DidResolver {
  const plcUrl = env.PLC_URL ?? DEFAULT_PLC_URL;
  if (resolverCache?.plcUrl !== plcUrl) {
    resolverCache = { plcUrl, resolve: createDidResolver({ plcUrl }) };
  }
  return resolverCache.resolve;
}

export function describeFeedGenerator(): Response {
  const did = feedGeneratorDid();
  return json({
    did,
    feeds: FEED_KINDS.map((kind) => ({ uri: feedUri(did, kind) }))
  });
}

/**
 * Page one feed. Authentication is required before any query for the
 * personalized kinds, so a caller without a valid token can never fall back to
 * the public page.
 */
export async function getFeedSkeleton(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const did = feedGeneratorDid();

  const rawFeed = url.searchParams.get('feed');
  if (rawFeed === null || rawFeed === '') {
    return fail(400, ERROR_INVALID_REQUEST, 'the feed parameter is required');
  }
  const kind = parseFeedUri(rawFeed, did);
  if (kind === null) {
    return fail(400, ERROR_INVALID_REQUEST, 'the feed parameter is not a feed of this generator');
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) {
    return fail(400, ERROR_INVALID_REQUEST, 'limit must be an integer between 1 and 100');
  }

  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor === null || rawCursor === '' ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && cursor === null) {
    return fail(400, ERROR_INVALID_REQUEST, 'the cursor is malformed');
  }

  let viewerDid: string | null = null;
  if (kind !== 'public') {
    const token = bearerToken(request.headers.get('authorization'));
    if (token === null) {
      return fail(401, ERROR_AUTH_REQUIRED, 'this feed requires an atproto service token');
    }
    try {
      viewerDid = await verifyFeedServiceJwt(token, {
        audience: `${did}#atproto_feed`,
        resolveDid: didResolver()
      });
    } catch (error) {
      if (error instanceof FeedAuthError) {
        return fail(401, ERROR_AUTH_REQUIRED, error.message);
      }
      throw error;
    }
  }

  let page: FeedSkeleton;
  try {
    page = await fetchFeedPage(catalogPool(), {
      kind,
      viewerDid,
      limit,
      cursor
    });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      return fail(503, ERROR_UNAVAILABLE, 'feed database is not configured');
    }
    console.error('[feeds] skeleton query failed', error);
    return fail(503, ERROR_UNAVAILABLE, 'feed database is unavailable');
  }

  return json(page);
}
