import { env } from '$env/dynamic/private';

/** Upstream request headers worth relaying; everything else is hop-by-hop. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'authorization', 'dpop'] as const;

/** Response headers the caller needs back (XRPC errors and DPoP replay data). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'dpop-nonce'] as const;

const DEFAULT_HAPPYVIEW_URL = 'http://127.0.0.1:3000';

/**
 * Proxy one XRPC call to HappyView and return its response unchanged.
 *
 * `method` is the NSID from the path; the verb comes from the request, which the
 * route has already constrained to GET or POST.
 */
export async function forward(method: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // The client identity belongs to this server, never to the browser. Deleting
  // first keeps a future forwarded-header addition from ever letting a caller
  // choose the credentials we present upstream.
  headers.delete('x-client-key');
  headers.delete('x-client-secret');
  if (env.HAPPYVIEW_CLIENT_KEY) headers.set('x-client-key', env.HAPPYVIEW_CLIENT_KEY);
  if (env.HAPPYVIEW_CLIENT_SECRET) headers.set('x-client-secret', env.HAPPYVIEW_CLIENT_SECRET);

  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
  const base = (env.HAPPYVIEW_URL || DEFAULT_HAPPYVIEW_URL).replace(/\/+$/, '');

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/xrpc/${method}${url.search}`, {
      method: request.method,
      headers,
      body
    });
  } catch {
    return new Response(JSON.stringify({ error: 'UpstreamUnavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  const response = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) response.set(name, value);
  }

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: response
  });
}
