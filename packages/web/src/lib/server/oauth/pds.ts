import { env } from '$env/dynamic/private';
import { base64url } from 'jose';
import { dpopFetch, type DpopPrivateJwk } from './dpop';

/**
 * The local PDS's authorization server, spoken to directly from this server.
 *
 * TLS: the PDS is behind Caddy's *internal* CA, which the host does not trust
 * by default. Node reads `NODE_EXTRA_CA_CERTS` once at startup, so the dev
 * server must be started with it pointing at `.cache/caddy-root.crt` (written
 * by `mise run hv-ca`). The alternative, `mise run hv-ca --system` plus
 * `--use-system-ca`, changes the whole host's trust store for one dev
 * dependency; the environment variable is scoped to this process. A deployed
 * edge talks to a PDS with a publicly trusted certificate and needs neither.
 */

const DEFAULT_PDS_URL = 'https://pds.127-0-0-1.sslip.io';

/**
 * The atproto spec's loopback client: `http://localhost` with no port and no
 * path, whose metadata the authorization server synthesises instead of
 * fetching. It is the only shape the local PDS accepts — inside its container
 * `127.0.0.1` is the container's own loopback (verified: a client_id pointing
 * at this app returns `401 invalid_client ... Failed to fetch client
 * metadata`), and a metadata URL served by this app is unreachable from there.
 *
 * The spec lets the virtual document be configured from the `client_id`'s own
 * query string, and `scope` is one of those fields. Without it the synthesised
 * document registers `atproto` alone, so a requested `transition:generic` comes
 * back in `rejected_scopes` as `not_registered` and the PDS mints an
 * `atproto` token — which cannot pass the `com.atproto.repo.createRecord`
 * scope check that HappyView's procedure writes need. With it, consent shows
 * both scopes and the token carries both (verified against the local PDS).
 */
export const CLIENT_ID = `http://localhost?scope=${encodeURIComponent('atproto transition:generic')}`;

/** Asked for in PAR, matching the `client_id`; the session registers what is granted. */
export const SCOPE = 'atproto transition:generic';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  revocation_endpoint?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

const metadataCache = new Map<string, AuthorizationServerMetadata>();

/**
 * The latest `DPoP-Nonce` per origin.
 *
 * RFC 9449 nonces are per server, and the PDS's authorization server and its
 * XRPC endpoints share an origin here. Cached in-process because a nonce only
 * outlives one request by design; the login's copy is also written into the
 * pending record so a restart mid-flow does not start from nothing.
 */
const nonces = new Map<string, string>();

function nonceFor(url: string): { nonce?: string; onNonce: (nonce: string) => void } {
  const origin = new URL(url).origin;
  return { nonce: nonces.get(origin), onNonce: (nonce) => nonces.set(origin, nonce) };
}

/** Fetch (once per process) the AS metadata document the `iss` of every flow points at. */
export async function authorizationServer(issuer?: string): Promise<AuthorizationServerMetadata> {
  const base = (issuer ?? env.PDS_URL ?? DEFAULT_PDS_URL).replace(/\/+$/, '');
  const cached = metadataCache.get(base);
  if (cached) return cached;

  const response = await fetch(`${base}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`authorization server discovery failed for ${base}: HTTP ${response.status}`);
  }
  const document = (await response.json()) as AuthorizationServerMetadata;
  if (!document.issuer || !document.token_endpoint) {
    throw new Error(`authorization server metadata for ${base} is incomplete`);
  }
  metadataCache.set(base, document);
  return document;
}

/**
 * Push the authorization request (the PDS sets
 * `require_pushed_authorization_requests`) and return the authorize URL.
 * PAR is itself a DPoP-bound request: the proof covers this call only.
 */
export async function pushAuthorizationRequest(options: {
  issuer?: string;
  key: DpopPrivateJwk;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
  loginHint?: string;
}): Promise<{ issuer: string; authorizeUrl: string; nonce?: string }> {
  const metadata = await authorizationServer(options.issuer);
  const endpoint = metadata.pushed_authorization_request_endpoint;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: options.scope ?? SCOPE,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256'
  });
  if (options.loginHint) body.set('login_hint', options.loginHint);

  let nonce: string | undefined;
  const response = await dpopFetch(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    },
    {
      key: options.key,
      ...nonceFor(endpoint),
      onNonce: (value) => {
        nonce = value;
        nonces.set(new URL(endpoint).origin, value);
      }
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    request_uri?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.request_uri) {
    throw new Error(
      `PAR failed: ${payload.error ?? response.status} ${payload.error_description ?? ''}`.trim()
    );
  }

  const authorize = new URL(metadata.authorization_endpoint);
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('request_uri', payload.request_uri);

  return {
    issuer: metadata.issuer,
    authorizeUrl: authorize.toString(),
    nonce
  };
}

/** Exchange the authorization code for the DPoP-bound token set. */
export async function exchangeCode(options: {
  issuer: string;
  key: DpopPrivateJwk;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  nonce?: string;
}): Promise<TokenSet> {
  const metadata = await authorizationServer(options.issuer);
  const endpoint = metadata.token_endpoint;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: options.codeVerifier
  });

  const response = await dpopFetch(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    },
    { key: options.key, ...nonceFor(endpoint) }
  );
  const payload = (await response.json().catch(() => ({}))) as TokenSet & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `token exchange failed: ${payload.error ?? response.status} ${payload.error_description ?? ''}`.trim()
    );
  }
  return payload;
}

/**
 * The `scope` claim of an access token — what the authorization server actually
 * granted, as opposed to what was requested.
 *
 * The token is not verified here: HappyView verifies it against the PDS when the
 * session is registered, and this value only decides what to ask it to store.
 * Registering a scope beyond the grant makes HappyView refresh the token and
 * refuse, so the granted value is the only correct input.
 */
export function grantedScope(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64url.decode(payload))) as {
      scope?: unknown;
    };
    return typeof claims.scope === 'string' ? claims.scope : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The authenticated identity behind a token, straight from the PDS.
 *
 * The DID is not read from the token's own claims: it is what HappyView will
 * verify against the same endpoint when the session is registered, and reading
 * it here means a mismatch surfaces at login rather than at the first write.
 */
export async function pdsSession(options: {
  issuer: string;
  key: DpopPrivateJwk;
  accessToken: string;
}): Promise<{ did: string; handle: string }> {
  const endpoint = `${options.issuer.replace(/\/+$/, '')}/xrpc/com.atproto.server.getSession`;
  const response = await dpopFetch(
    endpoint,
    { headers: { accept: 'application/json', authorization: `DPoP ${options.accessToken}` } },
    { key: options.key, accessToken: options.accessToken, ...nonceFor(endpoint) }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    did?: string;
    handle?: string;
    error?: string;
    message?: string;
  };
  if (!response.ok || !payload.did) {
    throw new Error(
      `getSession failed: ${payload.error ?? response.status} ${payload.message ?? ''}`.trim()
    );
  }
  return { did: payload.did, handle: payload.handle ?? payload.did };
}
