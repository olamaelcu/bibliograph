import { env } from '$env/dynamic/private';
import { Pool } from 'pg';
import { CatalogUnavailableError } from './errors';

/**
 * The catalog lives in this deployment's own Postgres; queries read the
 * authoritative tables (books, edition_identifiers, edition_contributors,
 * edition_identifier_publishers), never a PDS.
 *
 * A missing `DATABASE_URL` is a deployment error, but it must not crash the
 * process at import time: XRPC passthrough still works without catalog access.
 */
export { CatalogUnavailableError };

// SvelteKit dev reloads modules; keep one pool across reloads.
const shared = globalThis as typeof globalThis & {
  __bibliographCatalogPool?: Pool;
  __bibliographFeedPool?: Pool;
  __bibliographSearchPool?: Pool;
  __bibliographHydrationPool?: Pool;
};

/**
 * pg's rejection message when no pooled connection came free within
 * `connectionTimeoutMillis`. Distinct from a SQL error: the statement never
 * ran, the pool was saturated.
 */
const POOL_ACQUIRE_TIMEOUT = 'timeout exceeded when trying to connect';

export function isCatalogPoolTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === POOL_ACQUIRE_TIMEOUT;
}

/**
 * Five connections were the hard ceiling on catalog concurrency: one
 * multi-second aggregate held the whole surface to roughly one request per
 * second, and the rest queued until the acquire timeout above answered 503.
 * `CATALOG_POOL_MAX` overrides the default for a host that needs more or fewer.
 */
function catalogPoolMax(): number {
  const configured = Number(env.CATALOG_POOL_MAX);
  return Number.isInteger(configured) && configured > 0 ? configured : 15;
}

export function catalogPool(): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new CatalogUnavailableError();

  shared.__bibliographCatalogPool ??= new Pool({
    connectionString,
    max: catalogPoolMax(),
    idleTimeoutMillis: 30_000,
    // Fail inside a request rather than stalling a page render for five
    // seconds, and never let a runaway statement own a connection: both
    // timeouts answer 503 through `catalogFailure`, labelled `pool_timeout`
    // when the acquire is what timed out.
    connectionTimeoutMillis: 2_000,
    // The bound is the server's `statement_timeout`, not pg's client-side
    // `query_timeout`. The client timer abandons the promise while PostgreSQL
    // keeps executing the statement, so that connection answers nothing else
    // for the rest of the query's life; five of them and the pool stops
    // serving. Cancellation on the server keeps the connection healthy.
    statement_timeout: 5_000
  });

  return shared.__bibliographCatalogPool;
}

/**
 * The feed generator reads HappyView's `happyview_records`, not the catalog, and
 * owns its own latency: a feed page that takes seconds is the feed's problem.
 * Sharing the catalog pool's statement bound made every slow page a 503, so the
 * feed takes a pool of its own, with the same bounded acquire but no statement
 * bound.
 */
export function feedPool(): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new CatalogUnavailableError();

  shared.__bibliographFeedPool ??= new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000
  });

  return shared.__bibliographFeedPool;
}

/**
 * `searchEditions` is the one catalog read whose cost is set by the request:
 * four trigram branches over the whole catalogue, a hash aggregate over their
 * union and a sort of the page. Sharing the catalog pool meant a handful of
 * slow searches owned every connection that answers resolve, list and the
 * admin reads, and the 5 s statement bound parked each one for its full cost.
 * This pool bounds a search at two seconds and keeps five connections of its
 * own; an over-budget search answers 503 through `catalogFailure` instead of
 * starving the rest of the surface.
 */
export function searchPool(): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new CatalogUnavailableError();

  shared.__bibliographSearchPool ??= new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    // The deployment host has 2 vCPUs, 3.9 GB of RAM and a working set larger
    // than the buffer pool, so a search can stall behind IO. A client-side
    // `query_timeout` used to abandon those statements while PostgreSQL kept
    // running them; five such connections wedged the pool for good (a fresh
    // process answered the same query in 130–197 ms). The bound is the server's
    // `statement_timeout` now, so a slow search is cancelled and the connection
    // stays usable. The pool is separate, so it cannot starve resolve or list.
    // Five seconds: an XRPC caller gives up long before ten, and every second
    // spent past the client's patience only holds one of the five connections.
    statement_timeout: 5_000,
    // node-postgres sends unnamed statements, so the planner never sees the
    // pattern values and estimates every `ILIKE $n` at its 0.5% default. On
    // this catalogue that turned the three substring branches into sequential
    // scans of `books`, `contributors` and `edition_identifiers` — over ten
    // seconds under the host's IO pressure, while the same statement with
    // literals ran in 41–84 ms. Every branch has a trigram index (the vector
    // branch has a GIN), and this pool runs nothing else.
    options: '-c enable_seqscan=off'
  });

  return shared.__bibliographSearchPool;
}

/**
 * Hydration's own connections. The statement is fast in isolation (planning
 * 5 ms, index probes per uri); what it waits on is the host's disk — the page
 * measured 4.8 s for 25 uris with `shared read=1125 ms` inside one subplan. It
 * therefore gets its own pool and a wider bound than the search statement, so
 * a slow page cannot occupy the connections a search needs and vice versa.
 */
export function hydrationPool(): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new CatalogUnavailableError();

  shared.__bibliographHydrationPool ??= new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 10_000
  });
  return shared.__bibliographHydrationPool;
}
