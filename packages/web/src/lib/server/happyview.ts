import { env } from '$env/dynamic/private';

/** Upstream request headers worth relaying; everything else is hop-by-hop. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'authorization', 'dpop'] as const;

/** Response headers the caller needs back (XRPC errors and DPoP replay data). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'dpop-nonce'] as const;

const DEFAULT_HAPPYVIEW_URL = 'http://127.0.0.1:3000';

/**
 * The client identity belongs to this server, never to the browser.
 *
 * Built from scratch rather than copied from the request: a caller must not be
 * able to choose the credentials the edge presents upstream.
 */
function clientHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.HAPPYVIEW_CLIENT_KEY) headers['x-client-key'] = env.HAPPYVIEW_CLIENT_KEY;
  if (env.HAPPYVIEW_CLIENT_SECRET) headers['x-client-secret'] = env.HAPPYVIEW_CLIENT_SECRET;
  return headers;
}

/**
 * Proxy one XRPC call to HappyView and return its response unchanged.
 *
 * `method` is the NSID from the path; the verb comes from the request, which the
 * route has already constrained to GET or POST.
 *
 * The edge holds no user session. `authorization` and `dpop` are relayed from
 * the caller untouched: that is how a trusted server-side client presents an
 * inter-service JWT or its own DPoP-bound session, and HappyView — not this
 * proxy — decides what those credentials are worth.
 */
export async function forward(method: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  for (const [name, value] of Object.entries(clientHeaders())) headers.set(name, value);

  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    const base = (env.HAPPYVIEW_URL || DEFAULT_HAPPYVIEW_URL).replace(/\/+$/, '');
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
