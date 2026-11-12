import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { readAdminBody } from '$lib/server/admin/request';
import { workerAdminPost } from '$lib/server/admin/worker';

const NO_STORE = { 'cache-control': 'no-store' } as const;
// Up to five pages of a hundred ingests each; the default edge budget is far
// too short for that, and a partial answer would be worse than waiting.
const IMPORT_TIMEOUT_MS = 120_000;

export const POST: RequestHandler = async ({ cookies, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return json({ error: 'BadRequest', message: 'name is required' }, { status: 400, headers: NO_STORE });
  }

  const result = await workerAdminPost('/publisher-import', body, {
    timeoutMs: IMPORT_TIMEOUT_MS
  });
  return json(result.payload, { status: result.status, headers: NO_STORE });
};
