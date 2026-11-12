import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { workerAdminPost } from '$lib/server/admin/worker';
import { PROVIDERS, type Provider } from '$lib/admin/types';

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
  const { provider, query } = body as Record<string, unknown>;
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
    return json(
      { error: 'BadRequest', message: 'provider must be googlebooks, isbndb or goodreads' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (typeof query !== 'string' || query.trim() === '') {
    return json({ error: 'BadRequest', message: 'query is required' }, { status: 400, headers: NO_STORE });
  }

  const result = await workerAdminPost('/provider-search', {
    provider: provider as Provider,
    query
  });
  return json(result.payload, { status: result.status, headers: NO_STORE });
};
