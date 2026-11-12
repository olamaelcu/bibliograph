import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { loadEditionForEdit } from '$lib/server/admin/edition-edit';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

export const load: PageServerLoad = async ({ cookies, params }) => {
  requireAdmin(cookies);

  let edition;
  try {
    edition = await loadEditionForEdit(catalogPool(), params.id);
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] edition editor load failed', cause);
    error(503, 'the catalog is unavailable');
  }

  if (!edition) error(404, 'edition not found');
  return { edition };
};
