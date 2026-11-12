import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { workerAdminPost } from '$lib/server/admin/worker';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ cookies, request }) => {
  requireAdmin(cookies);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'BadRequest', message: 'request body must be JSON' }, { status: 400, headers: NO_STORE });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'BadRequest', message: 'request body must be an object' }, { status: 400, headers: NO_STORE });
  }
  const candidate = (body as Record<string, unknown>).candidate;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return json({ error: 'BadRequest', message: 'candidate is required' }, { status: 400, headers: NO_STORE });
  }

  const result = await workerAdminPost('/ingest', { candidate });
  return json(result.payload, { status: result.status, headers: NO_STORE });
};
