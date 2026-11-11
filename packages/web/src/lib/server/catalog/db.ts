import { env } from '$env/dynamic/private';
import { Pool } from 'pg';

/**
 * The catalog lives in this deployment's own Postgres; queries read the
 * authoritative tables (editions, edition_identifiers, edition_contributors,
 * edition_publishers), never a PDS.
 *
 * A missing `DATABASE_URL` is a deployment error, but it must not crash the
 * process at import time: XRPC passthrough still works without catalog access.
 */
export class CatalogUnavailableError extends Error {
  constructor(message = 'catalog database is not configured') {
    super(message);
    this.name = 'CatalogUnavailableError';
  }
}

// SvelteKit dev reloads modules; keep one pool across reloads.
const shared = globalThis as typeof globalThis & { __bibliographCatalogPool?: Pool };

export function catalogPool(): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new CatalogUnavailableError();

  shared.__bibliographCatalogPool ??= new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  return shared.__bibliographCatalogPool;
}
