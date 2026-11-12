import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { searchAdminEditions } from '$lib/server/admin/editions';
import { CatalogUnavailableError } from '$lib/server/catalog/db';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const GET: RequestHandler = async ({ cookies, url }) => {
  requireAdmin(cookies);

  const q = url.searchParams.get('q') ?? '';
  const rawLimit = Number(url.searchParams.get('limit') ?? '15');
  const limit = Number.isInteger(rawLimit) ? rawLimit : 15;

  try {
    return json({ items: await searchAdminEditions({ q, limit }) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      return json({ error: 'ServiceUnavailable', message: error.message }, { status: 503, headers: NO_STORE });
    }
    console.error('[admin] edition typeahead failed', error);
    return json(
      { error: 'ServiceUnavailable', message: 'catalog lookup failed' },
      { status: 503, headers: NO_STORE }
    );
  }
};
