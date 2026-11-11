import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { provisionDpopKey, registerSession, revokeSession, type DpopCaller } from '../happyview';
import { sha256Base64url } from './dpop';
import {
  exchangeCode,
  grantedScope,
  pdsSession,
  pushAuthorizationRequest,
  SCOPE
} from './pds';
import {
  createSession,
  deleteSession,
  getSession,
  savePending,
  takePending,
  updateSessionNonce,
  type StoredSession
} from './store';

/** Holds the opaque server-side session id; never a token or a key. */
export const SESSION_COOKIE = 'hv_session';

/** Mirrors the login's `state` for the one round trip to the PDS. */
export const LOGIN_COOKIE = 'hv_login';

const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60
} as const;

export const LOGIN_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 10 * 60
} as const;

export interface LoginStart {
  authorizeUrl: string;
  state: string;
}

/**
 * Start a login: mint a HappyView DPoP key, push the authorization request to
 * the PDS, and remember the PKCE verifier against the `state` we will see back.
 *
 * Order matters. The key has to exist before PAR, because PAR and the token
 * exchange are both DPoP-bound to it, and the same key must reach HappyView at
 * registration so its PDS writes use the session this flow creates.
 *
 * `origin` is the browser's origin, which is what the callback will come back
 * to; it is stored because the loopback client accepts only IP-literal
 * redirect URIs, so `http://localhost:5176` would be rejected at PAR.
 */
export async function beginLogin(origin: string, handle?: string): Promise<LoginStart> {
  const { provisionId, dpopKey } = await provisionDpopKey();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const redirectUri = `${origin}/oauth/callback`;

  const { authorizeUrl, issuer, nonce } = await pushAuthorizationRequest({
    key: dpopKey,
    redirectUri,
    state,
    codeChallenge: await sha256Base64url(verifier),
    loginHint: handle
  });

  savePending({
    state,
    verifier,
    provisionId,
    dpopKey,
    issuer,
    nonce,
    redirectUri,
    createdAt: new Date().toISOString()
  });

  return { authorizeUrl, state };
}

/**
 * Finish a login: exchange the code, read the DID from the PDS rather than from
 * the token, register the session with HappyView, and store it server-side.
 *
 * The registered scope is what the PDS *granted*, read from the access token:
 * registering the requested scope instead would make HappyView refresh the
 * token, find the difference, and refuse the session.
 */
export async function completeLogin(params: {
  code: string;
  state: string | null;
}): Promise<StoredSession> {
  const pending = takePending(params.state);
  if (!pending) {
    throw new Error('unknown or expired login state — start the sign-in again');
  }

  const tokens = await exchangeCode({
    issuer: pending.issuer,
    key: pending.dpopKey,
    code: params.code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.verifier,
    nonce: pending.nonce
  });

  const identity = await pdsSession({
    issuer: pending.issuer,
    key: pending.dpopKey,
    accessToken: tokens.access_token
  });

  const scopes = grantedScope(tokens.access_token) ?? tokens.scope ?? SCOPE;
  const expiresAt =
    tokens.expires_in === undefined
      ? undefined
      : new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await registerSession({
    provisionId: pending.provisionId,
    did: identity.did,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    scopes,
    pdsUrl: pending.issuer,
    issuer: pending.issuer
  });

  // No refresh at the edge: HappyView holds the refresh token and rotates it as
  // it needs to. This copy of the access token exists only to compute `ath` on
  // outgoing proofs, and it stays valid for that even after it expires.
  return createSession({
    did: identity.did,
    handle: identity.handle,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    scopes,
    dpopKey: pending.dpopKey,
    provisionId: pending.provisionId,
    issuer: pending.issuer,
    pdsUrl: pending.issuer
  });
}

export function currentSession(cookies: Cookies): StoredSession | undefined {
  return getSession(cookies.get(SESSION_COOKIE));
}

export function startSessionCookie(cookies: Cookies, session: StoredSession): void {
  cookies.set(SESSION_COOKIE, session.id, SESSION_COOKIE_OPTIONS);
}

/**
 * What the proxy presents to HappyView for a session: the access token, the
 * shared key, and a callback that keeps the stored nonce current.
 */
export function dpopCaller(session: StoredSession): DpopCaller {
  return {
    accessToken: session.accessToken,
    dpopKey: session.dpopKey,
    nonce: session.nonce,
    onNonce: (nonce) => updateSessionNonce(session.id, nonce)
  };
}

/**
 * Revoke this device's session at HappyView (which also revokes the tokens at
 * the PDS), then forget it locally. A failure upstream still clears the cookie:
 * the browser must not keep a session id whose tokens may already be gone.
 */
export async function endSession(cookies: Cookies): Promise<void> {
  const id = cookies.get(SESSION_COOKIE);
  const session = getSession(id);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  if (!session) return;
  await revokeSession({ did: session.did, caller: dpopCaller(session) });
  deleteSession(id);
}
