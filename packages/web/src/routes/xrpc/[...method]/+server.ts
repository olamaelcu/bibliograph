import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forward } from '$lib/server/happyview';
import { isPdsRead, proxyPdsRead } from '$lib/server/pds';
import { CatalogUnavailableError } from '$lib/server/catalog/db';
import { resolveEditions, searchEditions, type Identifier } from '$lib/server/catalog/editions';
import {
  enqueueResolveMiss,
  enqueueIsbnHydration,
  enqueueSearchHydration
} from '$lib/server/catalog/jobs';
import { isbn13sFromIdentifiers } from '$lib/server/catalog/isbn';
import {
  describeFeedGenerator,
  getFeedSkeleton,
  isFeedMethod,
  DESCRIBE_FEED_GENERATOR,
  GET_FEED_SKELETON
} from '$lib/server/feeds';

// An NSID is at least three labels: authority, name, and at least one more.
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

// Catalog discovery is anonymous, so bound the work a body can request.
const MAX_IDENTIFIERS = 100;

// A queued hydration job spends up to CANDIDATES_PER_TASK (50) paid provider
// lookups in the worker, and these procedures are anonymous, so one body must
// not be able to queue the whole identifier list. The cap is per request; the
// TTL marks dedupe repeats across calls, they are not a global quota.
const MAX_HYDRATION_JOBS_PER_REQUEST = 10;

const RESOLVE_EDITIONS = 'community.lexicon.media.book.resolveEditions';
const SEARCH_EDITIONS = 'community.lexicon.media.book.searchEditions';
const EDGE_PROCEDURES = new Set([RESOLVE_EDITIONS, SEARCH_EDITIONS]);

/**
 * CORS for the two catalog procedures only. Livtet's search and contributor
 * pages call them from the browser, so the preflight and the responses both
 * need to answer without credentials. Nothing else on this surface is a
 * browser-facing API, so no other route gains CORS.
 */
const CATALOG_CORS = {
  'Access-Control-Allow-Origin': '*',
  Vary: 'Origin'
} as const;

function catalogPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CATALOG_CORS,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function withCatalogCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CATALOG_CORS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function methodNotAllowed(): Response {
  return json({ error: 'MethodNotAllowed' }, { status: 405 });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, { status });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseIdentifiers(value: unknown): Identifier[] | null {
  if (!Array.isArray(value)) return null;

  const identifiers: Identifier[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    const { issuer, value: rawValue } = entry as Record<string, unknown>;
    if (typeof issuer !== 'string' || issuer === '') return null;
    if (typeof rawValue !== 'string' || rawValue === '') return null;
    // Identifier comparison is exact by contract: no normalization.
    const key = `${issuer}\u0000${rawValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ issuer, value: rawValue });
  }
  return identifiers;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function catalogFailure(error: unknown): Response {
  if (error instanceof CatalogUnavailableError) {
    return fail(503, 'ServiceUnavailable', 'catalog database is not configured');
  }
  console.error('[xrpc] catalog query failed', error);
  return fail(503, 'ServiceUnavailable', 'catalog unavailable');
}

async function handleResolve(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return fail(400, 'InvalidRequest', 'the request body must be a JSON object');

  const identifiers = parseIdentifiers(body.identifiers);
  if (identifiers === null || identifiers.length === 0) {
    return fail(400, 'InvalidRequest', 'identifiers must be a non-empty array of issuer/value pairs');
  }
  if (identifiers.length > MAX_IDENTIFIERS) {
    return fail(400, 'InvalidRequest', `at most ${MAX_IDENTIFIERS} identifiers per request`);
  }

  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, 'InvalidRequest', 'offset must be an integer');
  if (limit === null) return fail(400, 'InvalidRequest', 'limit must be an integer');

  try {
    const results = await resolveEditions({ identifiers, offset, limit });

    const matched = new Set<string>();
    for (const item of results.items) {
      for (const identifier of item.identifiers) {
        matched.add(`${identifier.issuer}\u0000${identifier.value}`);
      }
    }
    const unmatched = identifiers.filter(
      (identifier) => !matched.has(`${identifier.issuer}\u0000${identifier.value}`)
    );
    // Identifiers past the cap are still matched and answered; they are just
    // not queued on this call, and a later call that repeats the miss can
    // queue them.
    await Promise.all(
      unmatched
        .slice(0, MAX_HYDRATION_JOBS_PER_REQUEST)
        .map((identifier) => enqueueResolveMiss(identifier))
    );

    return json(results);
  } catch (error) {
    return catalogFailure(error);
  }
}

async function handleSearch(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return fail(400, 'InvalidRequest', 'the request body must be a JSON object');

  const q = optionalString(body.q);
  const title = optionalString(body.title);
  const author = optionalString(body.author);
  if (q === null || title === null || author === null) {
    return fail(400, 'InvalidRequest', 'q, title and author must be strings');
  }

  const identifiers = body.identifiers === undefined ? [] : parseIdentifiers(body.identifiers);
  if (identifiers === null) {
    return fail(400, 'InvalidRequest', 'identifiers must be an array of issuer/value pairs');
  }
  if (identifiers.length > MAX_IDENTIFIERS) {
    return fail(400, 'InvalidRequest', `at most ${MAX_IDENTIFIERS} identifiers per request`);
  }

  if (!q && !title && !author && identifiers.length === 0) {
    return fail(400, 'InvalidQuery', 'supply q, title, author, or at least one identifier');
  }

  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, 'InvalidRequest', 'offset must be an integer');
  if (limit === null) return fail(400, 'InvalidRequest', 'limit must be an integer');

  try {
    const results = await searchEditions({ q, title, author, identifiers, offset, limit });
    // An ISBN is worth a direct ISBNdb lookup even when the local catalog
    // answered: the job enriches/ingests the edition from the provider.
    // Only the first MAX_HYDRATION_JOBS_PER_REQUEST distinct ISBNs queue.
    await Promise.all(
      isbn13sFromIdentifiers(identifiers)
        .slice(0, MAX_HYDRATION_JOBS_PER_REQUEST)
        .map((isbn13) => enqueueIsbnHydration(isbn13))
    );
    // Discovery only hydrates when the local catalog has nothing for the query.
    if (results.items.length === 0) {
      await enqueueSearchHydration({ q, title, author, identifiers });
    }
    return json(results);
  } catch (error) {
    return catalogFailure(error);
  }
}

/**
 * Catalog discovery is served here, from the deployment's own catalog tables,
 * because the books-wg lexicons call them read-only procedures that must stay
 * anonymous. HappyView's procedure path requires a DPoP session for a PDS
 * write, so these two NSIDs never reach the proxy.
 *
 * Every other XRPC call is relayed to the AppView unchanged; the edge adds its
 * own client identity, and callers may present their own credentials.
 */
export const GET: RequestHandler = ({ params, request }) => {
  if (!NSID.test(params.method)) {
    return json({ error: 'InvalidRequest' }, { status: 400 });
  }
  // The feed generator is served at the edge from the activity index; it is a
  // GET-only pair, and `public` is the only anonymous feed.
  if (params.method === DESCRIBE_FEED_GENERATOR) return describeFeedGenerator();
  if (params.method === GET_FEED_SKELETON) return getFeedSkeleton(request);
  // Both books-wg methods are procedures.
  if (EDGE_PROCEDURES.has(params.method)) return methodNotAllowed();
  // Publisher-record reads go to the PDS; other com.atproto methods still go
  // to HappyView below.
  if (isPdsRead(params.method)) return proxyPdsRead(params.method, request);
  return forward(params.method, request);
};

export const POST: RequestHandler = async ({ params, request }) => {
  if (!NSID.test(params.method)) {
    return json({ error: 'InvalidRequest' }, { status: 400 });
  }
  if (isFeedMethod(params.method)) return methodNotAllowed();
  if (params.method === RESOLVE_EDITIONS) return withCatalogCors(await handleResolve(request));
  if (params.method === SEARCH_EDITIONS) return withCatalogCors(await handleSearch(request));
  return forward(params.method, request);
};

export const PUT: RequestHandler = () => methodNotAllowed();
export const PATCH: RequestHandler = () => methodNotAllowed();
export const DELETE: RequestHandler = () => methodNotAllowed();
export const OPTIONS: RequestHandler = ({ params }) => {
  // Only the browser-called catalog procedures answer a preflight; every other
  // path keeps the surface's 405.
  if (EDGE_PROCEDURES.has(params.method)) return catalogPreflight();
  return methodNotAllowed();
};
