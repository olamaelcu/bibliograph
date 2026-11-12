import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { PublisherEditResponse } from '$lib/admin/types';
import { requireAdmin } from '$lib/server/admin/auth';
import { entityErrorResponse } from '$lib/server/admin/entity-api';
import { updateAdminEntity } from '$lib/server/admin/entity-edit';
import { loadAdminEntity } from '$lib/server/admin/entity-read';
import { readAdminBody } from '$lib/server/admin/request';
import { catalogPool } from '$lib/server/catalog/db';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** The publisher editor's read path: numeric id or at-URI. */
export const GET: RequestHandler = async ({ cookies, params }) => {
  requireAdmin(cookies);

  try {
    const publisher = await loadAdminEntity(catalogPool(), 'publisher', params.id);
    if (!publisher) {
      return json(
        { error: 'NotFound', message: 'publisher not found' },
        { status: 404, headers: NO_STORE }
      );
    }
    const response: PublisherEditResponse = { publisher };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    return entityErrorResponse(error, 'publisher', 'read');
  }
};

export const POST: RequestHandler = async ({ cookies, params, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);

  try {
    const publisher = await updateAdminEntity(
      catalogPool(),
      'publisher',
      params.id,
      body
    );
    const response: PublisherEditResponse = { publisher };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    return entityErrorResponse(error, 'publisher', 'update');
  }
};
