/**
 * CORS for the anonymous catalog methods served at the edge.
 *
 * The books-wg procedures and the contributor/publisher reads are the only
 * browser-facing part of the XRPC surface: Livtet's search and entity pages
 * call them directly, so they need a credential-less preflight and response
 * headers. Nothing else on this surface is a browser API.
 */

export const CATALOG_CORS = {
  'Access-Control-Allow-Origin': '*',
  Vary: 'Origin'
} as const;

export function catalogPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CATALOG_CORS,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export function withCatalogCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CATALOG_CORS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
