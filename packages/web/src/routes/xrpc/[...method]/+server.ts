import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import {
  metrics,
  recordCatalogQuery,
  recordCatalogSearchDecision,
  recordCatalogSearchMatches,
  recordXrpcRequest,
  type XrpcBackend,
} from "$lib/server/metrics";
import { forward } from "$lib/server/happyview";
import { proxyPdsRead } from "$lib/server/pds";
import { catalogPool, isCatalogPoolTimeout } from "$lib/server/catalog/db";
import { CatalogUnavailableError, catalogFailure } from "$lib/server/catalog/errors";
import {
  resolveEditions,
  parseEditionOrder,
  searchEditions,
  type Identifier,
} from "$lib/server/catalog/editions";
import { withXrpcCors } from "$lib/server/xrpc/cors";
import {
  searchHydrationDecision,
  searchHydrationThreshold,
} from "$lib/server/catalog/search-hydration";
import {
  dispatchGet,
  dispatchMethodNotAllowed,
  dispatchOptions,
  dispatchPost,
  type XrpcDependencies,
} from "$lib/server/xrpc/dispatch";
import { SERVICE_DESCRIBE, describeService } from "$lib/server/xrpc/surface";
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
  GET_CONTRIBUTOR,
  GET_GENRES_OF_BOOK,
  GET_IDENTIFIED_FORMATS,
  GET_PUBLISHER,
  LIST_EDITIONS_BY_CONTRIBUTOR,
  RESOLVE_CONTRIBUTORS,
  RESOLVE_EDITIONS,
  RESOLVE_PUBLISHERS,
  SEARCH_CONTRIBUTORS,
  SEARCH_EDITIONS,
  SEARCH_PUBLISHERS,
} from "$lib/server/catalog/entity-methods";
import { decodeOffsetCursor } from "$lib/server/catalog/sql";
import { EDITION_COLLECTION, getEditionGenres } from "$lib/server/catalog/genres";
import { getEditionIdentifiedFormats } from "$lib/server/catalog/identified-formats";
import {
  enqueueResolveMiss,
  enqueueGenreFetch,
  enqueueIsbnHydration,
  enqueueSearchHydration,
} from "$lib/server/catalog/jobs";
import { isbn13sFromIdentifiers } from "$lib/server/catalog/isbn";
import { describeFeedGenerator, getFeedSkeleton } from "$lib/server/feeds";
import { DESCRIBE_FEED_GENERATOR, GET_FEED_SKELETON } from "$lib/server/feeds/methods";
import { coversBaseUrl } from "$lib/server/covers/config";

// Catalog discovery is anonymous, so bound the work a body can request.
const MAX_IDENTIFIERS = 100;

// The editor's own bound on a language value (`EDITION_EDIT_LIMITS.language`).
const MAX_LANGUAGE_LENGTH = 35;

// A queued hydration job spends up to CANDIDATES_PER_TASK (50) paid provider
// lookups in the worker, and these procedures are anonymous, so one body must
// not be able to queue the whole identifier list. The cap is per request; the
// TTL marks dedupe repeats across calls, they are not a global quota.
const MAX_HYDRATION_JOBS_PER_REQUEST = 10;

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, { status });
}

/**
 * The `bibliograph_catalog_queries_total` outcome for a failed catalog call.
 * A pool-acquire timeout is not a SQL error: the statement never ran.
 */
function catalogOutcome(error: unknown): "unavailable" | "pool_timeout" | "error" {
  if (error instanceof CatalogUnavailableError) return "unavailable";
  return isCatalogPoolTimeout(error) ? "pool_timeout" : "error";
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
    const results = await resolveEditions({
      identifiers,
      offset,
      limit,
      coversBaseUrl: coversBaseUrl(),
    }, catalogPool());
    recordCatalogQuery(metrics, "resolveEditions", "ok", (performance.now() - started) / 1000);

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
      catalogOutcome(error),
      (performance.now() - started) / 1000,
    );
    return catalogFailure(error);
  }
}

async function handleSearch(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return fail(400, "InvalidRequest", "the request body must be a JSON object");

  const q = optionalString(body.q);
  const title = optionalString(body.title);
  const author = optionalString(body.author);
  if (q === null || title === null || author === null) {
    return fail(400, "InvalidRequest", "q, title and author must be strings");
  }

  // `language` is a local extension: the upstream lexicon declares no filter.
  const language = optionalString(body.language);
  if (language === null) return fail(400, "InvalidRequest", "language must be a string");
  if (language !== undefined && language.length > MAX_LANGUAGE_LENGTH) {
    return fail(
      400,
      "InvalidRequest",
      `language must be at most ${MAX_LANGUAGE_LENGTH} characters`,
    );
  }

  const identifiers = body.identifiers === undefined ? [] : parseIdentifiers(body.identifiers);
  if (identifiers === null) {
    return fail(400, "InvalidRequest", "identifiers must be an array of issuer/value pairs");
  }
  if (identifiers.length > MAX_IDENTIFIERS) {
    return fail(400, "InvalidRequest", `at most ${MAX_IDENTIFIERS} identifiers per request`);
  }

  if (!q && !title && !author && !language && identifiers.length === 0) {
    return fail(
      400,
      "InvalidQuery",
      "supply q, title, author, language, or at least one identifier",
    );
  }

  const offset = boundedInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(body.limit, 25, 1, 100);
  if (offset === null) return fail(400, "InvalidRequest", "offset must be an integer");
  if (limit === null) return fail(400, "InvalidRequest", "limit must be an integer");

  // `sort` and `order` are a local extension: the upstream lexicon leaves
  // ranking to the provider, so it only declares the relevance order.
  const sort = optionalString(body.sort);
  const order = optionalString(body.order);
  if (sort === null) return fail(400, "InvalidRequest", "sort must be a string");
  if (order === null) return fail(400, "InvalidRequest", "order must be a string");

  const parsedOrder = parseEditionOrder({ sort, order });
  if ("error" in parsedOrder) return fail(400, "InvalidRequest", parsedOrder.error);

  const started = performance.now();
  try {
    const results = await searchEditions({
      q,
      title,
      author,
      identifiers,
      offset,
      limit,
      sort: parsedOrder.sort,
      order: parsedOrder.order,
      language,
      coversBaseUrl: coversBaseUrl(),
    }, catalogPool());
    recordCatalogQuery(metrics, "searchEditions", "ok", (performance.now() - started) / 1000);
    // An ISBN is worth a direct ISBNdb lookup even when the local catalog
    // answered: the job enriches/ingests the edition from the provider.
    // Only the first MAX_HYDRATION_JOBS_PER_REQUEST distinct ISBNs queue.
    await Promise.all(
      isbn13sFromIdentifiers(identifiers)
        .slice(0, MAX_HYDRATION_JOBS_PER_REQUEST)
        .map((isbn13) => enqueueIsbnHydration(isbn13)),
    );
    // A thin first page means the catalog likely lacks the work, not that the
    // caller paged deep. `total` exists only on the first page, so paging never
    // re-fires; an identifier-only body is covered by the catalog.isbn jobs
    // above, and a language-only browse has no provider text query to run.
    const hydration = searchHydrationDecision({
      hasText: Boolean(q || title || author),
      offset,
      total: results.total,
      threshold: searchHydrationThreshold(env.SEARCH_HYDRATION_THRESHOLD),
    });
    recordCatalogSearchDecision(metrics, hydration);
    if (results.total !== undefined) recordCatalogSearchMatches(metrics, results.total);
    if (hydration === "thin") {
      await enqueueSearchHydration({ q, title, author, identifiers });
    }
    return json(results);
  } catch (error) {
    recordCatalogQuery(
      metrics,
      "searchEditions",
      catalogOutcome(error),
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
    if (method === GET_GENRES_OF_BOOK) {
      const uri = params.get("uri");
      if (uri === null || uri === "") {
        return fail(400, "InvalidRequest", "`uri` is required");
      }
      if (parseEntityUri(uri, EDITION_COLLECTION) === null) {
        return fail(400, "InvalidRequest", "`uri` must be an edition record at-uri");
      }

      const started = performance.now();
      try {
        const result = await getEditionGenres(pool, uri);
        if (result === null) {
          return fail(404, "RecordNotFound", "no edition has that URI");
        }
        recordCatalogQuery(
          metrics,
          "getGenresOfBook",
          "ok",
          (performance.now() - started) / 1000,
        );
        // An edition with no genres yet is a miss, not an error: queue one
        // provider fetch. The ledger inside the SQL function dedupes it across
        // callers, so a hot edition cannot flood the queue.
        if (result.genres.length === 0) await enqueueGenreFetch(uri);
        return json(result);
      } catch (error) {
        recordCatalogQuery(
          metrics,
          "getGenresOfBook",
          catalogOutcome(error),
          (performance.now() - started) / 1000,
        );
        return catalogFailure(error);
      }
    }

    if (method === GET_IDENTIFIED_FORMATS) {
      const uri = params.get("uri");
      if (uri === null || uri === "") {
        return fail(400, "InvalidRequest", "`uri` is required");
      }
      if (parseEntityUri(uri, EDITION_COLLECTION) === null) {
        return fail(400, "InvalidRequest", "`uri` must be an edition record at-uri");
      }

      const started = performance.now();
      try {
        const result = await getEditionIdentifiedFormats(pool, uri);
        if (result === null) {
          return fail(404, "RecordNotFound", "no edition has that URI");
        }
        recordCatalogQuery(
          metrics,
          "getIdentifiedFormats",
          "ok",
          (performance.now() - started) / 1000,
        );
        // No hydration job: the claims arrive with the identifier's provider
        // record during ingest, so there is nothing left to fetch here.
        return json(result);
      } catch (error) {
        recordCatalogQuery(
          metrics,
          "getIdentifiedFormats",
          catalogOutcome(error),
          (performance.now() - started) / 1000,
        );
        return catalogFailure(error);
      }
    }

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
      // The same local extensions `searchEditions` accepts, so one contributor's
      // page can be narrowed and ordered identically.
      const language = (params.get("language") ?? "").trim();
      if (language.length > MAX_LANGUAGE_LENGTH) {
        return fail(
          400,
          "InvalidRequest",
          `language must be at most ${MAX_LANGUAGE_LENGTH} characters`,
        );
      }
      const parsedOrder = parseEditionOrder({
        sort: params.get("sort"),
        order: params.get("order"),
      });
      if ("error" in parsedOrder) return fail(400, "InvalidRequest", parsedOrder.error);
      const page = await listEditionsByContributor(pool, {
        contributor,
        ...(language === "" ? {} : { language }),
        sort: parsedOrder.sort,
        order: parsedOrder.order,
        offset: decodeOffsetCursor(params.get("cursor")),
        limit,
        coversBaseUrl: coversBaseUrl(),
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
 * Time one XRPC call and label it with the backend that answered it. Wrapping
 * the dependency table is what makes the metric count every call exactly once:
 * `dispatchGet`/`dispatchPost` pick the handler, and this records whichever one
 * they picked without the route re-classifying the NSID a second time.
 */
function timed<Args extends unknown[]>(
  backend: XrpcBackend,
  run: (...args: Args) => Response | Promise<Response>,
  methodOf: (...args: Args) => string,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const started = performance.now();
    try {
      const response = await run(...args);
      recordXrpcRequest(metrics, {
        method: methodOf(...args),
        backend,
        status: response.status,
        durationSeconds: (performance.now() - started) / 1000,
      });
      return response;
    } catch (error) {
      recordXrpcRequest(metrics, {
        method: methodOf(...args),
        backend,
        status: 0,
        outcome: "exception",
        durationSeconds: (performance.now() - started) / 1000,
      });
      throw error;
    }
  };
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
const dependencies: XrpcDependencies = {
  // Static: no database, no auth, no FEED_GENERATOR_DID, so it never 503s.
  serviceDescribe: timed("catalog", () => json(describeService()), () => SERVICE_DESCRIBE),
  describeFeedGenerator: timed("feed", describeFeedGenerator, () => DESCRIBE_FEED_GENERATOR),
  getFeedSkeleton: timed("feed", getFeedSkeleton, () => GET_FEED_SKELETON),
  entityGet: timed("catalog", handleEntityGet, (_request, method) => method),
  resolveEditions: timed("catalog", handleResolve, () => RESOLVE_EDITIONS),
  searchEditions: timed("catalog", handleSearch, () => SEARCH_EDITIONS),
  entityResolve: timed("catalog", handleEntityResolve, (_request, method) => method),
  proxyPdsRead: timed("pds", proxyPdsRead, (method) => method),
  forward: timed("happyview", forward, (method) => method),
};

const handleGet: RequestHandler = ({ params, request }) =>
  dispatchGet(params.method, request, dependencies);

const handlePost: RequestHandler = ({ params, request }) =>
  dispatchPost(params.method, request, dependencies);

const handleOptions: RequestHandler = ({ params }) => dispatchOptions(params.method);

const handleOtherVerb: RequestHandler = ({ params }) =>
  dispatchMethodNotAllowed(params.method);

// CORS is applied once, to whatever the dispatch returned: every method,
// including the 400/405 branches and the proxied responses, gets the same
// headers, and no branch can return a response that bypasses them.
export const GET: RequestHandler = withXrpcCors(handleGet);
export const POST: RequestHandler = withXrpcCors(handlePost);
export const OPTIONS: RequestHandler = withXrpcCors(handleOptions);
export const PUT: RequestHandler = withXrpcCors(handleOtherVerb);
export const PATCH: RequestHandler = withXrpcCors(handleOtherVerb);
export const DELETE: RequestHandler = withXrpcCors(handleOtherVerb);
