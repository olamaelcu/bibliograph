import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { BookEditError, deleteAdminBook, loadBookForEdit } from '$lib/server/admin/book-edit';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

export const load: PageServerLoad = async ({ cookies, params }) => {
  requireAdmin(cookies);

  let edition;
  try {
    edition = await loadBookForEdit(catalogPool(), params.id);
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] edition editor load failed', cause);
    error(503, 'the catalog is unavailable');
  }

  if (!edition) error(404, 'edition not found');
  return { edition };
};

export const actions: Actions = {
  // Destructive and final: the row and everything keyed to it go, and the
  // catalog trigger queues the record deletion. The form carries the revision
  // the editor loaded, so a concurrent save is a 409 instead of a silent loss.
  delete: async ({ cookies, params, request }) => {
    requireAdmin(cookies);

    const form = await request.formData();
    const revision = String(form.get('revision') ?? '').trim();

    try {
      await deleteAdminBook(catalogPool(), params.id, revision === '' ? null : revision);
    } catch (cause) {
      if (cause instanceof BookEditError) {
        return fail(cause.status, { message: cause.message });
      }
      if (cause instanceof CatalogUnavailableError) {
        return fail(503, { message: cause.message });
      }
      console.error('[admin] edition delete failed', cause);
      return fail(500, { message: 'the delete failed and was rolled back' });
    }

    redirect(303, '/admin#edit');
  }
};
