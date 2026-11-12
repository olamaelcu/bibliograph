import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ContributorEditResponse } from '$lib/admin/types';
import { requireAdmin } from '$lib/server/admin/auth';
import { entityErrorResponse } from '$lib/server/admin/entity-api';
import { updateAdminEntity } from '$lib/server/admin/entity-edit';
import { loadAdminEntity } from '$lib/server/admin/entity-read';
import { readAdminBody } from '$lib/server/admin/request';
import { catalogPool } from '$lib/server/catalog/db';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** The contributor editor's read path: numeric id or at-URI. */
export const GET: RequestHandler = async ({ cookies, params }) => {
  requireAdmin(cookies);

  try {
    const contributor = await loadAdminEntity(catalogPool(), 'contributor', params.id);
    if (!contributor) {
      return json(
        { error: 'NotFound', message: 'contributor not found' },
        { status: 404, headers: NO_STORE }
      );
    }
    const response: ContributorEditResponse = { contributor };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    return entityErrorResponse(error, 'contributor', 'read');
  }
};

export const POST: RequestHandler = async ({ cookies, params, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);

  try {
    const contributor = await updateAdminEntity(
      catalogPool(),
      'contributor',
      params.id,
      body
    );
    const response: ContributorEditResponse = { contributor };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    return entityErrorResponse(error, 'contributor', 'update');
  }
};
