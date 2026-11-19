/**
 * The librarian client's OAuth metadata, as a function of the origin the browser
 * is on.
 *
 * Two shapes, because the authorization server treats them differently:
 *
 *  - **https** — a discoverable client. `client_id` is this app's own metadata
 *    URL, which the server fetches, and the redirect URI sits on that origin.
 *
 *  - **http** — a development host, using the RFC 8252 loopback client. The
 *    `client_id` is `http://localhost?redirect_uri=…` and no document is
 *    fetched: the metadata lives in the id itself. The library refuses the
 *    `localhost` *hostname* in a redirect URI (RFC 8252 §8.3), so the callback is
 *    always written with `127.0.0.1`; browsing at `localhost` therefore also has
 *    to be redirected, or the cookie would land on the other host.
 */

import { buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-types';
import type { OAuthClientMetadataInput } from '@atproto/oauth-client-node';

import { redirectUri } from './return-to.ts';

const METADATA_PATH = '/oauth-client-metadata.json';

/** Only local development speaks plain HTTP. */
export function isInsecureOrigin(origin: string): boolean {
  return new URL(origin).protocol === 'http:';
}


/** The metadata document this app serves, or the loopback client id. */
export function librarianClientMetadata(origin: string): OAuthClientMetadataInput {
  if (isInsecureOrigin(origin)) {
    return buildAtprotoLoopbackClientMetadata({
      scope: 'atproto',
      redirect_uris: [redirectUri(origin)]
    }) as unknown as OAuthClientMetadataInput;
  }

  return {
    client_name: 'Bibliograph librarians',
    client_id: `${origin}${METADATA_PATH}`,
    client_uri: origin,
    redirect_uris: [`${origin}/librarian/oauth/callback`],
    scope: 'atproto',
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true
  };
}
