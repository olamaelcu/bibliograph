/**
 * CORS for the whole `/xrpc/[...method]` surface.
 *
 * Every browser call to an XRPC method on this deployment goes through the
 * edge, including the proxied HappyView and PDS reads. A browser preflights
 * `GET`/`POST` with `DPoP` and `Authorization` headers even when the method is
 * not one the edge serves itself, so the headers belong to the route, not to
 * the catalog methods.
 *
 * These are headers only: nothing here reads the request, so no response
 * varies by origin and no credential is ever allowed or reflected.
 */

/** Origin-independent response headers every XRPC answer carries. */
const XRPC_CORS = {
  'Access-Control-Allow-Origin': '*',
  Vary: 'Origin',
  'Access-Control-Expose-Headers': 'dpop-nonce'
} as const;

/** Preflight contract. `dpop`/`authorization` must pass or authenticated calls fail. */
const PREFLIGHT = {
  ...XRPC_CORS,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, dpop, accept',
  'Access-Control-Max-Age': '86400'
} as const;

/**
 * Apply the response headers to any response.
 *
 * `Headers.set` is used rather than `append`, so a response that already carries
 * a CORS header (a proxied one, or one produced twice by a wrapper) ends up with
 * exactly one value; an upstream origin is replaced by `*`, never reflected.
 */
export function applyXrpcCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(XRPC_CORS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/** The `204` preflight answer for a valid NSID on any verb. */
export function xrpcPreflight(): Response {
  return new Response(null, { status: 204, headers: PREFLIGHT });
}

/**
 * Wrap a route handler so every response it returns carries CORS headers.
 *
 * Exported except for its use as the single composition point in the route:
 * a new dispatch branch cannot forget the headers because it cannot return a
 * response that bypasses this wrapper.
 */
export function withXrpcCors<Event extends { params: { method: string } }>(
  handler: (event: Event) => Response | Promise<Response>
): (event: Event) => Promise<Response> {
  return async (event) => applyXrpcCors(await handler(event));
}
