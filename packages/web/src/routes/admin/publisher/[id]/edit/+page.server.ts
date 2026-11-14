import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { EntityEditError, deleteAdminEntity } from '$lib/server/admin/entity-edit';
import { loadAdminEntity } from '$lib/server/admin/entity-read';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

export const load: PageServerLoad = async ({ cookies, params }) => {
  requireAdmin(cookies);

  let publisher;
  try {
    publisher = await loadAdminEntity(catalogPool(), 'publisher', params.id);
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] publisher editor load failed', cause);
    error(503, 'the catalog is unavailable');
  }

  if (!publisher) error(404, 'publisher not found');
  return { publisher };
};

export const actions: Actions = {
  // Refused while an identifier still links the row: the link table is
  // ON DELETE RESTRICT and merging is the supported way to retire a linked
  // publisher. An unlinked row is removed and its record deletion queued.
  delete: async ({ cookies, params, request }) => {
    requireAdmin(cookies);

    const form = await request.formData();
    const revision = String(form.get('revision') ?? '').trim();

    try {
      await deleteAdminEntity(
        catalogPool(),
        'publisher',
        params.id,
        revision === '' ? null : revision
      );
    } catch (cause) {
      if (cause instanceof EntityEditError) {
        return fail(cause.status, { message: cause.message });
      }
      if (cause instanceof CatalogUnavailableError) {
        return fail(503, { message: cause.message });
      }
      console.error('[admin] publisher delete failed', cause);
      return fail(500, { message: 'the delete failed and was rolled back' });
    }

    redirect(303, '/admin#publishers');
  }
};
