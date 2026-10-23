// ATProto OAuth client for Bibliograph.
//
// Bibliograph is an OAuth *client* (not a resource server): a user signs in with
// their own handle, and the resulting session lets us write to that user's repo.
// Nothing here grants access to the catalog DID — catalog edits are derived from
// the user's own `editionWorkLink` records (see edition-work-votes.ts).
//
// Two client-id modes:
//   * Production/SaaS: `OAUTH_CLIENT_ID` is an HTTPS URL serving
//     `/oauth-client-metadata.json` from this app.
//   * Local development: no client id configured, so we build an ATProto
//     loopback client id (`http://localhost?redirect_uri=…&scope=…`), which
//     carries its metadata inline and needs no publicly reachable host. Loopback
//     redirect URIs must be 127.0.0.1 or [::1], hence the default origin below.
//
// DPoP keys live inside the stored session, so `oauth_sessions.value` is secret
// material: it is only ever read by this server.

import { NodeOAuthClient, buildAtprotoLoopbackClientMetadata, requestLocalLock } from '@atproto/oauth-client-node';
import type {
  AtprotoDid,
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
  OAuthClientMetadataInput,
  OAuthLoopbackRedirectURI,
} from '@atproto/oauth-client-node';

import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { oauthSessions, oauthStates } from '$lib/server/db/schema';
import { EDITION_WORK_LINK_COLLECTION } from '$lib/server/edition-work-votes';

export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/**
 * Least privilege: only the vote collection, and only the mutations a vote
 * needs. The user's shelves, profile, and everything else stay out of reach.
 */
export const OAUTH_SCOPE = [
  'atproto',
  `repo:${EDITION_WORK_LINK_COLLECTION}?action=create&action=update&action=delete`,
].join(' ');

const STATE_TTL_MS = 15 * 60 * 1000;

export function publicOrigin(): string {
  const configured = process.env.OAUTH_PUBLIC_ORIGIN ?? process.env.ORIGIN;
  if (configured) return configured.replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.OAUTH_DEV_PORT ?? '5176'}`;
}

export function redirectUri(): string {
  return `${publicOrigin()}${OAUTH_CALLBACK_PATH}`;
}

export function isLoopbackClient(): boolean {
  return !process.env.OAUTH_CLIENT_ID;
}

export function clientMetadata(): OAuthClientMetadataInput {
  const redirect_uris: [string, ...string[]] = [redirectUri()];
  if (isLoopbackClient()) {
    return buildAtprotoLoopbackClientMetadata({
      scope: OAUTH_SCOPE,
      // The redirect URI is built from `OAUTH_PUBLIC_ORIGIN`, which must be a
      // loopback origin in this mode (http://127.0.0.1:<port>).
      redirect_uris: [redirectUri() as OAuthLoopbackRedirectURI],
    });
  }
  return {
    client_id: process.env.OAUTH_CLIENT_ID!,
    client_name: 'Bibliograph',
    client_uri: publicOrigin(),
    redirect_uris,
    scope: OAUTH_SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

const stateStore: NodeSavedStateStore = {
  async get(key) {
    const [row] = await db.select().from(oauthStates).where(eq(oauthStates.key, key));
    if (!row) return undefined;
    if (row.expiresAt.getTime() <= Date.now()) {
      await stateStore.del(key);
      return undefined;
    }
    return row.value as NodeSavedState;
  },
  async set(key, value) {
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await db
      .insert(oauthStates)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: oauthStates.key, set: { value, expiresAt } });
  },
  async del(key) {
    await db.delete(oauthStates).where(eq(oauthStates.key, key));
  },
};

const sessionStore: NodeSavedSessionStore = {
  async get(key) {
    const [row] = await db.select().from(oauthSessions).where(eq(oauthSessions.did, key));
    return row ? (row.value as NodeSavedSession) : undefined;
  },
  async set(key, value) {
    await db
      .insert(oauthSessions)
      .values({ did: key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: oauthSessions.did,
        set: { value, updatedAt: new Date() },
      });
  },
  async del(key) {
    await db.delete(oauthSessions).where(eq(oauthSessions.did, key));
  },
};

let clientPromise: Promise<NodeOAuthClient> | undefined;

export function getOAuthClient(): Promise<NodeOAuthClient> {
  clientPromise ??= Promise.resolve(
    new NodeOAuthClient({
      clientMetadata: clientMetadata(),
      stateStore,
      sessionStore,
      requestLock: requestLocalLock,
      allowHttp: publicOrigin().startsWith('http://'),
    }),
  );
  return clientPromise;
}

export interface PutRecordResult {
  uri: string;
  cid: string;
}

/**
 * Write a record into the signed-in user's own repo. The OAuth session is
 * restored server-side from `oauth_sessions`; the caller never passes a token.
 */
export async function putUserRecord(
  did: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<PutRecordResult> {
  const client = await getOAuthClient();
  // The session store is keyed by DID, and every caller holds one.
  const session = await client.restore(did as AtprotoDid);

  // `fetchHandler` prepends the PDS base URL and signs the request (DPoP + a
  // fresh access token), so the payload here is plain JSON on the wire.
  const response = await session.fetchHandler('/xrpc/com.atproto.repo.putRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: did, collection, rkey, record, validate: true }),
  });

  const body = (await response.json().catch(() => null)) as
    | { uri?: string; cid?: string; error?: string; message?: string }
    | null;

  if (!response.ok || !body?.uri || !body.cid) {
    throw new Error(body?.message ?? body?.error ?? `putRecord failed (HTTP ${response.status})`);
  }

  return { uri: body.uri, cid: body.cid };
}

/** Forget a user's stored OAuth session (used on logout). */
export async function forgetOAuthSession(did: string): Promise<void> {
  try {
    const client = await getOAuthClient();
    await client.revoke(did);
  } catch {
    // Revocation is best-effort: an expired or already-revoked token set throws.
  }
  await sessionStore.del(did);
}
