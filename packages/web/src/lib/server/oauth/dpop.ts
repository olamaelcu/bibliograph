import { base64url, importJWK, SignJWT, type JWK } from 'jose';

/** A provisioned private JWK, as HappyView returns it from `/oauth/dpop-keys`. */
export type DpopPrivateJwk = JWK & { d: string; crv: 'P-256'; kty: 'EC' };

/**
 * The public half of a provisioned key.
 *
 * The `d` parameter must never reach a proof header: the header is sent to the
 * verifier, and it is what the RFC 7638 thumbprint is computed from, so leaking
 * it would hand over the key that authorises every write.
 */
export function publicJwk(key: DpopPrivateJwk): JWK {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}

/** base64url(SHA-256(value)) without padding — `ath` and the PKCE challenge. */
export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

export interface DpopProofOptions {
  key: DpopPrivateJwk;
  /** Request method, upper case on the wire. */
  htm: string;
  /** Absolute request URL; query and fragment are stripped per RFC 9449 §4.2. */
  htu: string;
  /** Present when the request carries an access token: signs its SHA-256 hash. */
  accessToken?: string;
  /** The server's latest `DPoP-Nonce`, once it has issued one. */
  nonce?: string;
}

/**
 * Build a `dpop+jwt` proof for exactly one request.
 *
 * `jose` does the ES256 signing and the base64url/JWT encoding; this function
 * only assembles the claims. `jti` is fresh per call (a verifier rejects a
 * reused one within the proof's acceptance window) and `iat` is seconds.
 */
export async function dpopProof({
  key,
  htm,
  htu,
  accessToken,
  nonce
}: DpopProofOptions): Promise<string> {
  const privateKey = await importJWK(key, 'ES256');
  const url = new URL(htu);
  const claims: Record<string, unknown> = {
    htm,
    htu: `${url.origin}${url.pathname}`,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID()
  };
  if (accessToken !== undefined) claims.ath = await sha256Base64url(accessToken);
  if (nonce !== undefined) claims.nonce = nonce;

  return new SignJWT(claims)
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk(key) })
    .sign(privateKey);
}

export interface DpopFetchOptions {
  key: DpopPrivateJwk;
  /** Sent in `ath` and expected in `Authorization: DPoP <token>` by the caller. */
  accessToken?: string;
  /** The last nonce seen from this origin, if any. */
  nonce?: string;
  /** Called with every `DPoP-Nonce` the server returns, so it can be persisted. */
  onNonce?: (nonce: string) => void;
}

/**
 * `fetch` with a proof minted per attempt, including the nonce dance.
 *
 * A server may answer the first attempt with `use_dpop_nonce` and a
 * `DPoP-Nonce` header; the retry has to carry that value as a `nonce` claim.
 * The retry is a *new* proof (new `jti`, new `iat`) — a proof is never reused,
 * and there is exactly one retry so a server that keeps asking cannot loop.
 */
export async function dpopFetch(
  url: string,
  init: RequestInit,
  options: DpopFetchOptions
): Promise<Response> {
  const htm = (init.method ?? 'GET').toUpperCase();
  let nonce = options.nonce;

  for (let attempt = 0; ; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set(
      'dpop',
      await dpopProof({ key: options.key, htm, htu: url, accessToken: options.accessToken, nonce })
    );

    const response = await fetch(url, { ...init, headers });
    const issued = response.headers.get('dpop-nonce');
    if (issued) {
      nonce = issued;
      options.onNonce?.(issued);
    }

    if (attempt > 0) return response;
    if (issued && (response.status === 400 || response.status === 401)) {
      const body = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { error?: string };
      if (body.error === 'use_dpop_nonce') continue;
    }
    return response;
  }
}
