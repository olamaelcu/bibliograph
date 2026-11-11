import { env } from '$env/dynamic/private';
import { dpopFetch, type DpopPrivateJwk } from './oauth/dpop';

/** Upstream request headers worth relaying; everything else is hop-by-hop. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'authorization', 'dpop'] as const;

/** Response headers the caller needs back (XRPC errors and DPoP replay data). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'dpop-nonce'] as const;

const DEFAULT_HAPPYVIEW_URL = 'http://127.0.0.1:3000';

/** What the edge must present to HappyView on behalf of a signed-in user. */
export interface DpopCaller {
  /** Sent as `Authorization: DPoP <token>`; its SHA-256 goes into the proof's `ath`. */
  accessToken: string;
  /** The private key HappyView provisioned and shares with this server. */
  dpopKey: DpopPrivateJwk;
  /** The last `DPoP-Nonce` HappyView issued to this session, if it issues any. */
  nonce?: string;
  /** Called whenever a response carries a fresh `DPoP-Nonce`, so it can be stored. */
  onNonce?: (nonce: string) => void;
}

function baseUrl(): string {
  return (env.HAPPYVIEW_URL || DEFAULT_HAPPYVIEW_URL).replace(/\/+$/, '');
}

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

function clientHeadersWithoutSecret(): Record<string, string> {
  return env.HAPPYVIEW_CLIENT_KEY ? { 'x-client-key': env.HAPPYVIEW_CLIENT_KEY } : {};
}

function failure(action: string, response: Response, body: Record<string, unknown>): Error {
  const detail =
    (typeof body.error_description === 'string' && body.error_description) ||
    (typeof body.message === 'string' && body.message) ||
    (typeof body.error === 'string' && body.error) ||
    response.statusText;
  return new Error(`${action} failed: HTTP ${response.status} ${detail}`);
}

/**
 * Proxy one XRPC call to HappyView and return its response unchanged.
 *
 * `method` is the NSID from the path; the verb comes from the request, which the
 * route has already constrained to GET or POST.
 *
 * With a `caller`, the edge replaces any caller-supplied `Authorization`/`DPoP`
 * with a fresh proof signed by that user's provisioned key, so HappyView resolves
 * the request to their DID instead of treating it as anonymous. Without one, the
 * request is relayed exactly as before.
 */
export async function forward(
  method: string,
  request: Request,
  caller?: DpopCaller
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  for (const [name, value] of Object.entries(clientHeaders())) headers.set(name, value);

  const base = baseUrl();
  const target = `${base}/xrpc/${method}${url.search}`;

  if (caller) {
    // HappyView validates `htu` against its own PUBLIC_URL and the Host header,
    // with no query string, so the proof covers the endpoint rather than the
    // call — every request still gets a fresh `jti`, `iat` and `ath`.
    headers.set('authorization', `DPoP ${caller.accessToken}`);
  }

  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = caller
      ? await dpopFetch(
          target,
          { method: request.method, headers, body },
          {
            key: caller.dpopKey,
            accessToken: caller.accessToken,
            nonce: caller.nonce,
            onNonce: caller.onNonce
          }
        )
      : await fetch(target, { method: request.method, headers, body });
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

/**
 * `POST /oauth/dpop-keys` — ask HappyView for a DPoP keypair for this login.
 *
 * The response carries the *private* JWK: this server signs proofs with it and
 * HappyView keeps an encrypted copy to sign the PDS writes it makes on the
 * same session. The two therefore share one key, which is the whole point of
 * the flow.
 */
export async function provisionDpopKey(): Promise<{
  provisionId: string;
  dpopKey: DpopPrivateJwk;
  confidential: boolean;
}> {
  const response = await fetch(`${baseUrl()}/oauth/dpop-keys`, {
    method: 'POST',
    headers: { ...clientHeaders(), 'content-type': 'application/json', accept: 'application/json' },
    body: '{}'
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw failure('dpop-key provisioning', response, body);
  const provisionId = body.provision_id;
  const dpopKey = body.dpop_key;
  if (typeof provisionId !== 'string' || typeof dpopKey !== 'object' || dpopKey === null) {
    throw new Error('dpop-key provisioning returned no key');
  }
  return {
    provisionId,
    dpopKey: dpopKey as DpopPrivateJwk,
    confidential: body.confidential === true
  };
}

/**
 * `POST /oauth/sessions` — hand the token set to HappyView.
 *
 * HappyView looks up the provisioned key by `provision_id`, checks the access
 * token really belongs to `did` at the PDS, and stores the session. It owns
 * refreshing from then on; the edge keeps its own copy of the same tokens only
 * to compute `ath`.
 */
export async function registerSession(options: {
  provisionId: string;
  did: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string;
  pdsUrl: string;
  issuer: string;
}): Promise<{ sessionId: string; did: string; scopes: string[] }> {
  const payload: Record<string, unknown> = {
    provision_id: options.provisionId,
    did: options.did,
    access_token: options.accessToken,
    scopes: options.scopes,
    pds_url: options.pdsUrl,
    issuer: options.issuer
  };
  if (options.refreshToken) payload.refresh_token = options.refreshToken;
  if (options.expiresAt) payload.expires_at = options.expiresAt;

  const response = await fetch(`${baseUrl()}/oauth/sessions`, {
    method: 'POST',
    headers: { ...clientHeaders(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw failure('session registration', response, body);
  return {
    sessionId: String(body.session_id ?? ''),
    did: String(body.did ?? ''),
    scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : []
  };
}

/**
 * `DELETE /oauth/sessions/:did` — revoke *this device's* session.
 *
 * Authenticated by the DPoP proof rather than the client secret, so it removes
 * only the session whose key signed the request and leaves other devices of the
 * same user alone. HappyView then revokes the tokens at the PDS.
 */
export async function revokeSession(options: { did: string; caller: DpopCaller }): Promise<void> {
  const path = `/oauth/sessions/${encodeURIComponent(options.did)}`;
  const response = await dpopFetch(
    `${baseUrl()}${path}`,
    {
      method: 'DELETE',
      headers: {
        // The client key without the secret: HappyView prefers the secret when
        // it is present, and the secret authenticates the client rather than
        // one device — taking that branch revokes every session the user has
        // with this client, signing them out everywhere.
        ...clientHeadersWithoutSecret(),
        authorization: `DPoP ${options.caller.accessToken}`
      }
    },
    {
      key: options.caller.dpopKey,
      accessToken: options.caller.accessToken,
      nonce: options.caller.nonce,
      onNonce: options.caller.onNonce
    }
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw failure('session revocation', response, body);
  }
}
