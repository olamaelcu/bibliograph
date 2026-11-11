import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forward } from '../../../lib/server/happyview';

// An NSID is at least three labels: authority, name, and at least one more.
const NSID = /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

function methodNotAllowed(): Response {
  return json({ error: 'MethodNotAllowed' }, { status: 405 });
}

const handle: RequestHandler = ({ params, request }) =>
  NSID.test(params.method)
    ? forward(params.method, request)
    : json({ error: 'InvalidRequest' }, { status: 400 });

export const GET: RequestHandler = handle;
export const POST: RequestHandler = handle;

export const PUT: RequestHandler = methodNotAllowed;
export const PATCH: RequestHandler = methodNotAllowed;
export const DELETE: RequestHandler = methodNotAllowed;
export const OPTIONS: RequestHandler = methodNotAllowed;
