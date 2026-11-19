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
    statement_timeout: 5_000,
    query_timeout: 5_000
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
    // The deployment host has 2 vCPUs, 3.9 GB of RAM and a working set
    // (`book_search` + `edition_shape` + `happyview_records`) larger than the
    // buffer pool, so a search stalls behind IO for seconds while the catalog
    // pool's cheap reads stay fast. A two-second bound turned every one of
    // those stalls into a 503 (measured: exactly 2.005 s, then "Query read
    // timeout"); ten seconds lets the statement finish. The pool is separate,
    // so a slow search still cannot starve resolve or list.
    statement_timeout: 10_000,
    query_timeout: 10_000
  });

  return shared.__bibliographSearchPool;
}
