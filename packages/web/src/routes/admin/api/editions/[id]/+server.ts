import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { EditionEditResponse } from '$lib/admin/types';
import { requireAdmin } from '$lib/server/admin/auth';
import { EditionEditError, updateAdminEdition } from '$lib/server/admin/edition-edit';
import { readAdminBody } from '$lib/server/admin/request';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ cookies, params, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);

  try {
    const edition = await updateAdminEdition(catalogPool(), params.id, body);
    const response: EditionEditResponse = { edition };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof EditionEditError) {
      return json(
        { error: error.code, message: error.message, field: error.field },
        { status: error.status, headers: NO_STORE }
      );
    }
    if (error instanceof CatalogUnavailableError) {
      return json(
        { error: 'ServiceUnavailable', message: error.message },
        { status: 503, headers: NO_STORE }
      );
    }
    console.error('[admin] edition update failed', error);
    return json(
      { error: 'UpdateFailed', message: 'the update failed and was rolled back' },
      { status: 500, headers: NO_STORE }
    );
  }
};
