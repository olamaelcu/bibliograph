/**
 * Catalog error envelope shared by every edge-served catalog method.
 *
 * The class lives here rather than in `db.ts` so modules that only map errors
 * (and their tests) do not pull in `$env/dynamic/private`.
 */

export class CatalogUnavailableError extends Error {
  constructor(message = 'catalog database is not configured') {
    super(message);
    this.name = 'CatalogUnavailableError';
  }
}

function failure(error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status: 503,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Map a catalog failure to `503 ServiceUnavailable`. A missing configuration
 * and an unreachable database are the same status to a caller, but the message
 * distinguishes them for an operator reading logs.
 */
export function catalogFailure(error: unknown): Response {
  if (error instanceof CatalogUnavailableError) {
    return failure('ServiceUnavailable', 'catalog database is not configured');
  }
  console.error('[xrpc] catalog query failed', error);
  return failure('ServiceUnavailable', 'catalog unavailable');
}
