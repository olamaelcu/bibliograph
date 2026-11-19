/**
 * The librarian's own OAuth client.
 *
 * One client per origin, built from the request's origin so the metadata
 * document the authorization server fetches is the one this app serves —
 * `client_id` has to equal that URL, and the dev server, a preview build and the
 * production edge are all the same code.
 *
 * This is separate from the Livtet platform's client on purpose: different
 * client, different redirect URI, and only `atproto` is requested. A librarian
 * needs an identity to sign decisions with, not the catalog's scopes.
 */

import {
  NodeOAuthClient,
  requestLocalLock,
} from '@atproto/oauth-client-node';
import type { NodeOAuthClientOptions, OAuthClientMetadataInput } from '@atproto/oauth-client-node';
import { env } from '$env/dynamic/private';

import { catalogPool } from '../catalog/db.ts';
import { isInsecureOrigin, librarianClientMetadata } from './client-metadata.ts';
import { librarianSessionStore, librarianStateStore } from './stores.ts';

const clients = new Map<string, NodeOAuthClient>();

/**
 * The client for one origin, memoized.
 *
 * Construction opens no sockets; it only wires the stores and metadata, so a
 * cache miss on a cold request is cheap.
 */
export function librarianOAuthClient(origin: string): NodeOAuthClient {
  const cached = clients.get(origin);
  if (cached) return cached;

  const pool = catalogPool();
  const options: NodeOAuthClientOptions = {
    clientMetadata: librarianClientMetadata(origin),
    stateStore: librarianStateStore(pool),
    sessionStore: librarianSessionStore(pool),
    // One lid on token refresh per process is enough for a handful of
    // librarians; the alternative is a distributed lock for a queue that a
    // person reads.
    requestLock: requestLocalLock,
    // A development host speaks plain HTTP end to end (edge, PDS, PLC), and the
    // client refuses that by default. Production is https, so the exception is
    // scoped to an http origin rather than to a build mode.
    allowHttp: isInsecureOrigin(origin),
    // The client's default fetch is SSRF-hardened: it refuses plain http, custom
    // ports and private/loopback addresses, which is the entire local stack
    // (`https://pds.127-0-0-1.sslip.io`, `http://127.0.0.1:2582` for the PLC).
    // Identity resolution therefore reported "handle does not resolve" until
    // this override let plain `fetch` through — development only, because
    // production resolves public identities and keeps the hardened default.
    ...(isInsecureOrigin(origin)
      ? {
          fetch: globalThis.fetch,
          // The default resolver asks public DNS and public well-known, neither
          // of which knows a handle hosted on the local PDS. Ask that PDS
          // instead; production keeps the default resolver.
          ...(env.PDS_URL ? { handleResolver: new URL(env.PDS_URL) } : {})
        }
      : {}),
    ...(env.PLC_URL ? { plcDirectoryUrl: env.PLC_URL } : {})
  };
  const client = new NodeOAuthClient(options);
  clients.set(origin, client);
  return client;
}
