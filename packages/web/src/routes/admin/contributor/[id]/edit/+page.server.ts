import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { loadAdminEntity } from '$lib/server/admin/entity-read';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

export const load: PageServerLoad = async ({ cookies, params }) => {
  requireAdmin(cookies);

  let contributor;
  try {
    contributor = await loadAdminEntity(catalogPool(), 'contributor', params.id);
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] contributor editor load failed', cause);
    error(503, 'the catalog is unavailable');
  }

  if (!contributor) error(404, 'contributor not found');
  return { contributor };
};
