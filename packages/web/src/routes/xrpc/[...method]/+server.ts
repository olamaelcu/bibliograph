import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { metrics, recordCatalogQuery } from "$lib/server/metrics";
import { forward } from "$lib/server/happyview";
import { isPdsRead, proxyPdsRead } from "$lib/server/pds";
import { catalogPool } from "$lib/server/catalog/db";
import { CatalogUnavailableError, catalogFailure } from "$lib/server/catalog/errors";
import { resolveEditions, searchEditions, type Identifier } from "$lib/server/catalog/editions";
import { catalogPreflight, withCatalogCors } from "$lib/server/catalog/cors";
import {
  EntityQueryError,
  EntityUriError,
  CONTRIBUTOR_COLLECTION,
  getContributor,
  getPublisher,
  listEditionsByContributor,
  parseEntityUri,
  resolveContributors,
  resolvePublishers,
  searchContributors,
  searchPublishers,
} from "$lib/server/catalog/entities";
import {
  ENTITY_METHODS,
  ENTITY_PROCEDURES,
  ENTITY_QUERIES,
  GET_CONTRIBUTOR,
  GET_PUBLISHER,
  LIST_EDITIONS_BY_CONTRIBUTOR,
  RESOLVE_CONTRIBUTORS,
  RESOLVE_PUBLISHERS,
  SEARCH_CONTRIBUTORS,
  SEARCH_PUBLISHERS,
} from "$lib/server/catalog/entity-methods";
import { decodeOffsetCursor } from "$lib/server/catalog/sql";
import {
  enqueueResolveMiss,
  enqueueIsbnHydration,
  enqueueSearchHydration,
} from "$lib/server/catalog/jobs";
import { isbn13sFromIdentifiers } from "$lib/server/catalog/isbn";
import {
  describeFeedGenerator,
  getFeedSkeleton,
  isFeedMethod,
  DESCRIBE_FEED_GENERATOR,
  GET_FEED_SKELETON,
} from "$lib/server/feeds";

// An NSID is at least three labels: authority, name, and at least one more.
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

// Catalog discovery is anonymous, so bound the work a body can request.
const MAX_IDENTIFIERS = 100;

// A queued hydration job spends up to CANDIDATES_PER_TASK (50) paid provider
// lookups in the worker, and these procedures are anonymous, so one body must
// not be able to queue the whole identifier list. The cap is per request; the
// TTL marks dedupe repeats across calls, they are not a global quota.
const MAX_HYDRATION_JOBS_PER_REQUEST = 10;

const RESOLVE_EDITIONS = "community.lexicon.media.book.resolveEditions";
const SEARCH_EDITIONS = "community.lexicon.media.book.searchEditions";
const EDGE_PROCEDURES = new Set([RESOLVE_EDITIONS, SEARCH_EDITIONS]);

function methodNotAllowed(): Response {
  return json({ error: "MethodNotAllowed" }, { status: 405 });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, { status });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
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
    if (entry === null || typeof entry !== "object") return null;
    const { issuer, value: rawValue } = entry as Record<string, unknown>;
    if (typeof issuer !== "string" || issuer === "") return null;
    if (typeof rawValue !== "string" || rawValue === "") return null;
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
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

async function handleResolve(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return fail(400, "InvalidRequest", "the request body must be a JSON object");

  const identifiers = parseIdentifiers(body.identifiers);
  if (identifiers === null || identifiers.length === 0) {
    return fail(
      400,
      "InvalidRequest",
      "identifiers must be a non-empty array of issuer/value pairs",
    );
  }
  if (identifiers.length > MAX_IDENTIFIERS) {
    return fail(400, "InvalidRequest", `at most ${MAX_IDENTIFIERS} identifiers per request`);
  }

  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, "InvalidRequest", "offset must be an integer");
  if (limit === null) return fail(400, "InvalidRequest", "limit must be an integer");

  const started = performance.now();
  try {
    const results = await resolveEditions({ identifiers, offset, limit });
    recordCatalogQuery(
      metrics,
      "resolveEditions",
      "ok",
      (performance.now() - started) / 1000,
    );

    const matched = new Set<string>();
    for (const item of results.items) {
      for (const identifier of item.identifiers) {
        matched.add(`${identifier.issuer}\u0000${identifier.value}`);
      }
    }
    const unmatched = identifiers.filter(
      (identifier) => !matched.has(`${identifier.issuer}\u0000${identifier.value}`),
    );
    // Identifiers past the cap are still matched and answered; they are just
    // not queued on this call, and a later call that repeats the miss can
    // queue them.
    await Promise.all(
      unmatched
        .slice(0, MAX_HYDRATION_JOBS_PER_REQUEST)
        .map((identifier) => enqueueResolveMiss(identifier)),
    );

    return json(results);
  } catch (error) {
    recordCatalogQuery(
      metrics,
      "resolveEditions",
      error instanceof CatalogUnavailableError ? "unavailable" : "error",
      (performance.now() - started) / 1000,
    );
    return catalogFailure(error);
  }
}

async function handleSearch(request: Request): Promise<Response> {
  console.log(request);
  const body = await readBody(request);
  if (body === null) return fail(400, "InvalidRequest", "the request body must be a JSON object");

  const q = optionalString(body.q);
  const title = optionalString(body.title);
  const author = optionalString(body.author);
  if (q === null || title === null || author === null) {
    return fail(400, "InvalidRequest", "q, title and author must be strings");
  }

  const identifiers = body.identifiers === undefined ? [] : parseIdentifiers(body.identifiers);
  if (identifiers === null) {
    return fail(400, "InvalidRequest", "identifiers must be an array of issuer/value pairs");
  }
  if (identifiers.length > MAX_IDENTIFIERS) {
    return fail(400, "InvalidRequest", `at most ${MAX_IDENTIFIERS} identifiers per request`);
  }

  if (!q && !title && !author && identifiers.length === 0) {
    return fail(400, "InvalidQuery", "supply q, title, author, or at least one identifier");
  }

  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, "InvalidRequest", "offset must be an integer");
  if (limit === null) return fail(400, "InvalidRequest", "limit must be an integer");

  const started = performance.now();
  try {
    const results = await searchEditions({ q, title, author, identifiers, offset, limit });
    recordCatalogQuery(
      metrics,
      "searchEditions",
      "ok",
      (performance.now() - started) / 1000,
    );
    // An ISBN is worth a direct ISBNdb lookup even when the local catalog
    // answered: the job enriches/ingests the edition from the provider.
    // Only the first MAX_HYDRATION_JOBS_PER_REQUEST distinct ISBNs queue.
    await Promise.all(
      isbn13sFromIdentifiers(identifiers)
        .slice(0, MAX_HYDRATION_JOBS_PER_REQUEST)
        .map((isbn13) => enqueueIsbnHydration(isbn13)),
    );
    // Discovery only hydrates when the local catalog has nothing for the query.
    if (results.items.length === 0) {
      await enqueueSearchHydration({ q, title, author, identifiers });
    }
    return json(results);
  } catch (error) {
    recordCatalogQuery(
      metrics,
      "searchEditions",
      error instanceof CatalogUnavailableError ? "unavailable" : "error",
      (performance.now() - started) / 1000,
    );
    return catalogFailure(error);
  }
}

/** Parse an integer query parameter, clamped to [min, max]; null when it is not one. */
function queryInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Entity getters and searches. They read the catalog tables, never a PDS, and
 * are anonymous like the books-wg procedures.
 */
async function handleEntityGet(request: Request, method: string): Promise<Response> {
  const params = new URL(request.url).searchParams;
  try {
    const pool = catalogPool();
    if (method === GET_CONTRIBUTOR || method === GET_PUBLISHER) {
      const uri = params.get("uri");
      if (uri === null || uri === "") {
        return fail(400, "InvalidRequest", "`uri` is required");
      }
      if (method === GET_CONTRIBUTOR) {
        const contributor = await getContributor(pool, uri);
        if (contributor === null) {
          return fail(404, "RecordNotFound", "no contributor has that URI");
        }
        return json({ contributor });
      }
      const publisher = await getPublisher(pool, uri);
      if (publisher === null) return fail(404, "RecordNotFound", "no publisher has that URI");
      return json({ publisher });
    }

    if (method === LIST_EDITIONS_BY_CONTRIBUTOR) {
      const contributor = params.get("contributor");
      if (contributor === null || contributor === "") {
        return fail(400, "InvalidRequest", "`contributor` is required");
      }
      if (parseEntityUri(contributor, CONTRIBUTOR_COLLECTION) === null) {
        return fail(400, "InvalidRequest", "`contributor` must be a contributor record at-uri");
      }
      const limit = queryInteger(params.get("limit"), 25, 1, 100);
      if (limit === null) return fail(400, "InvalidRequest", "`limit` must be an integer");
      const page = await listEditionsByContributor(pool, {
        contributor,
        offset: decodeOffsetCursor(params.get("cursor")),
        limit,
      });
      if (page === null) return fail(404, "RecordNotFound", "no contributor has that URI");
      return json(page);
    }

    const q = (params.get("q") ?? "").trim();
    if (q === "") return fail(400, "InvalidQuery", "`q` is required");
    if (q.length > 256) return fail(400, "InvalidRequest", "`q` is limited to 256 characters");
    const limit = queryInteger(params.get("limit"), 25, 1, 100);
    if (limit === null) return fail(400, "InvalidRequest", "`limit` must be an integer");
    const cursor = params.get("cursor") ?? undefined;
    const results =
      method === SEARCH_CONTRIBUTORS
        ? await searchContributors(pool, { q, limit, cursor })
        : await searchPublishers(pool, { q, limit, cursor });
    return json(results);
  } catch (error) {
    if (error instanceof EntityUriError) return fail(400, "InvalidRequest", error.message);
    if (error instanceof EntityQueryError) return fail(400, "InvalidQuery", error.message);
    return catalogFailure(error);
  }
}

/** Identifier lookups: exact pairs in a JSON body, paged like resolveEditions. */
async function handleEntityResolve(request: Request, method: string): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return fail(400, "InvalidRequest", "the request body must be a JSON object");

  const identifiers = parseIdentifiers(body.identifiers);
  if (identifiers === null || identifiers.length === 0 || identifiers.length > MAX_IDENTIFIERS) {
    return fail(
      400,
      "InvalidRequest",
      `identifiers must be a non-empty array of at most ${MAX_IDENTIFIERS} issuer/value pairs`,
    );
  }
  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, "InvalidRequest", "offset must be an integer");
  if (limit === null) return fail(400, "InvalidRequest", "limit must be an integer");

  try {
    const pool = catalogPool();
    const results =
      method === RESOLVE_CONTRIBUTORS
        ? await resolveContributors(pool, { identifiers, offset, limit })
        : await resolvePublishers(pool, { identifiers, offset, limit });
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
export const GET: RequestHandler = async ({ params, request }) => {
  if (!NSID.test(params.method)) {
    return json({ error: "InvalidRequest" }, { status: 400 });
  }
  // The feed generator is served at the edge from the activity index; it is a
  // GET-only pair, and `public` is the only anonymous feed.
  if (params.method === DESCRIBE_FEED_GENERATOR) return describeFeedGenerator();
  if (params.method === GET_FEED_SKELETON) return getFeedSkeleton(request);
  if (ENTITY_QUERIES.has(params.method)) {
    return withCatalogCors(await handleEntityGet(request, params.method));
  }
  // The books-wg and entity procedures are POST-only.
  if (EDGE_PROCEDURES.has(params.method) || ENTITY_PROCEDURES.has(params.method)) {
    return methodNotAllowed();
  }
  // Publisher-record reads go to the PDS; other com.atproto methods still go
  // to HappyView below.
  if (isPdsRead(params.method)) return proxyPdsRead(params.method, request);
  return forward(params.method, request);
};

export const POST: RequestHandler = async ({ params, request }) => {
  if (!NSID.test(params.method)) {
    return json({ error: "InvalidRequest" }, { status: 400 });
  }
  if (isFeedMethod(params.method)) return methodNotAllowed();
  if (params.method === RESOLVE_EDITIONS) return withCatalogCors(await handleResolve(request));
  if (params.method === SEARCH_EDITIONS) return withCatalogCors(await handleSearch(request));
  if (ENTITY_PROCEDURES.has(params.method)) {
    return withCatalogCors(await handleEntityResolve(request, params.method));
  }
  // Entity getters and searches are GET-only.
  if (ENTITY_QUERIES.has(params.method)) return methodNotAllowed();
  return forward(params.method, request);
};

export const PUT: RequestHandler = () => methodNotAllowed();
export const PATCH: RequestHandler = () => methodNotAllowed();
export const DELETE: RequestHandler = () => methodNotAllowed();
export const OPTIONS: RequestHandler = ({ params }) => {
  // Only the browser-called catalog methods answer a preflight; every other
  // path keeps the surface's 405.
  if (EDGE_PROCEDURES.has(params.method) || ENTITY_METHODS.has(params.method)) {
    return catalogPreflight();
  }
  return methodNotAllowed();
};
