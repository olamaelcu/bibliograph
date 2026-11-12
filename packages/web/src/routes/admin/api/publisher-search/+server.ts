import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { readAdminBody } from '$lib/server/admin/request';
import { workerAdminPost } from '$lib/server/admin/worker';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ cookies, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return json({ error: 'BadRequest', message: 'query is required' }, { status: 400, headers: NO_STORE });
  }

  const result = await workerAdminPost('/publisher-search', body);
  return json(result.payload, { status: result.status, headers: NO_STORE });
};
