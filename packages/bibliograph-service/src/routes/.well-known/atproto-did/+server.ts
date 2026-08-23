import { getDidDocument } from '$lib/server/did';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  // Per https://atproto.com/specs/handle#handle-resolution, the HTTP fallback returns
  // the DID as plain text (not JSON) when /.well-known/atproto-did is queried.
  const did = getDidDocument().id;
  return new Response(did, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
};