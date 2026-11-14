import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { MergeError, mergeEditions } from '$lib/server/admin/merge';
import { CatalogUnavailableError, catalogPool } from '$lib/server/catalog/db';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ cookies, request }) => {
  requireAdmin(cookies);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'BadRequest', message: 'request body must be JSON' }, { status: 400, headers: NO_STORE });
  }

  try {
    return json(await mergeEditions(catalogPool(), body), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MergeError) {
      return json({ error: 'MergeRejected', message: error.message }, { status: error.status, headers: NO_STORE });
    }
    if (error instanceof CatalogUnavailableError) {
      return json({ error: 'ServiceUnavailable', message: error.message }, { status: 503, headers: NO_STORE });
    }
    console.error('[admin] edition merge failed', error);
    return json(
      { error: 'MergeFailed', message: 'the merge failed and was rolled back' },
      { status: 500, headers: NO_STORE }
    );
  }
};
