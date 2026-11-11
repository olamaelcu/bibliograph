import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forward } from '../../../lib/server/happyview';

// An NSID is at least three labels: authority, name, and at least one more.
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

function methodNotAllowed(): Response {
  return json({ error: 'MethodNotAllowed' }, { status: 405 });
}

/**
 * Every XRPC call goes through here.
 *
 * The edge adds its own client identity and relays the rest as-is, so callers
 * may be anonymous (public queries) or present their own credentials for
 * HappyView to authenticate.
 */
const handle: RequestHandler = ({ params, request }) => {
  if (!NSID.test(params.method)) {
    return json({ error: 'InvalidRequest' }, { status: 400 });
  }
  return forward(params.method, request);
};

export const GET: RequestHandler = handle;
export const POST: RequestHandler = handle;

export const PUT: RequestHandler = methodNotAllowed;
export const PATCH: RequestHandler = methodNotAllowed;
export const DELETE: RequestHandler = methodNotAllowed;
export const OPTIONS: RequestHandler = methodNotAllowed;
