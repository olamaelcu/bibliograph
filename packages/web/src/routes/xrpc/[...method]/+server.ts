import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forward } from '../../../lib/server/happyview';
import { currentSession, dpopCaller } from '../../../lib/server/oauth/flow';

// An NSID is at least three labels: authority, name, and at least one more.
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

function methodNotAllowed(): Response {
  return json({ error: 'MethodNotAllowed' }, { status: 405 });
}

/**
 * Every XRPC call goes through here.
 *
 * With a signed-in session the edge signs the request with that user's
 * provisioned DPoP key, so HappyView resolves a caller DID — and, for
 * procedures, proxies the write to that user's PDS. Without one it relays the
 * request exactly as before (anonymous, or whatever the caller supplied).
 */
const handle: RequestHandler = async ({ params, request, cookies }) => {
  if (!NSID.test(params.method)) {
    return json({ error: 'InvalidRequest' }, { status: 400 });
  }
  const session = currentSession(cookies);
  return forward(params.method, request, session ? dpopCaller(session) : undefined);
};

export const GET: RequestHandler = handle;
export const POST: RequestHandler = handle;

export const PUT: RequestHandler = methodNotAllowed;
export const PATCH: RequestHandler = methodNotAllowed;
export const DELETE: RequestHandler = methodNotAllowed;
export const OPTIONS: RequestHandler = methodNotAllowed;
