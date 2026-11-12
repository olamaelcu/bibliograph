import { env } from '$env/dynamic/private';

import { metrics, recordPdsProxyRequest } from '$lib/server/metrics';

/** Request headers worth relaying; everything else is hop-by-hop. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type'] as const;

/** A hung PDS becomes a `502` rather than holding the caller open forever. */
const PDS_TIMEOUT_MS = 15_000;

function failure(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message === undefined ? { error } : { error, message }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Proxy one read-only publisher-record call to `${PDS_URL}/xrpc/<nsid>?…`.
 *
 * The query string is relayed verbatim: `repo`, `collection`, `rkey` and
 * `cursor` are the caller's, not the edge's. The upstream status, body and
 * content type are returned unchanged so an XRPC error from the PDS reaches the
 * client as the status the PDS chose.
 *
 * Every other `com.atproto.*` method stays on the HappyView `forward()` path;
 * this proxy deliberately handles exactly the two reads above.
 */
async function proxyPdsReadRequest(method: string, request: Request): Promise<Response> {
  const base = env.PDS_URL?.replace(/\/+$/, '');
  if (!base) {
    return failure(
      503,
      'ServiceUnavailable',
      'PDS_URL is not configured; com.atproto.repo reads are unavailable'
    );
  }

  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/xrpc/${method}${url.search}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PDS_TIMEOUT_MS)
    });
  } catch {
    return failure(502, 'UpstreamUnavailable');
  }

  const response = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) response.set('content-type', contentType);

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: response
  });
}

/** Count one publisher-record read and relay it, with the status the caller saw. */
export async function proxyPdsRead(method: string, request: Request): Promise<Response> {
  try {
    const response = await proxyPdsReadRequest(method, request);
    recordPdsProxyRequest(metrics, { method, status: response.status });
    return response;
  } catch (error) {
    recordPdsProxyRequest(metrics, { method, status: 0, outcome: 'exception' });
    throw error;
  }
}
