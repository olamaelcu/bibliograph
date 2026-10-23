import { clientMetadata } from '$lib/server/auth/oauth';
import type { RequestHandler } from './$types';

// Served at the `client_id` URL in production (OAUTH_CLIENT_ID). In loopback
// development the client id carries this metadata inline instead, so the route
// is harmless but unused.
export const GET: RequestHandler = () =>
  new Response(JSON.stringify(clientMetadata(), null, 2), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    },
  });
