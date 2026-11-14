import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { loadAdminEntity } from '$lib/server/admin/entity-read';
import {
  ContributorMergeError,
  mergeContributors,
  previewContributorMerge
} from '$lib/server/admin/entity-merge';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

export const load: PageServerLoad = async ({ cookies, params, url }) => {
  requireAdmin(cookies);
  const pool = catalogPool();

  let source;
  try {
    source = await loadAdminEntity(pool, 'contributor', params.id);
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] contributor merge load failed', cause);
    error(503, 'the catalog is unavailable');
  }
  if (!source) error(404, 'contributor not found');

  const into = (url.searchParams.get('into') ?? '').trim();
  if (into === '') {
    return { source, target: null, plan: null, into, targetError: null };
  }

  try {
    const preview = await previewContributorMerge(pool, {
      source: String(source.id),
      target: into
    });
    return { source, target: preview.target, plan: preview.plan, into, targetError: null };
  } catch (cause) {
    // A mistyped or stale target is an operator mistake, not a broken page:
    // keep the picker usable and report it inline.
    if (cause instanceof ContributorMergeError) {
      return { source, target: null, plan: null, into, targetError: cause.message };
    }
    if (cause instanceof CatalogUnavailableError) error(503, cause.message);
    console.error('[admin] contributor merge preview failed', cause);
    error(503, 'the catalog is unavailable');
  }
};

export const actions: Actions = {
  merge: async ({ cookies, params, request }) => {
    requireAdmin(cookies);

    const form = await request.formData();
    const target = String(form.get('target') ?? '').trim();
    const sourceRevision = String(form.get('sourceRevision') ?? '').trim();
    const targetRevision = String(form.get('targetRevision') ?? '').trim();

    let targetId: number;
    try {
      const result = await mergeContributors(catalogPool(), {
        source: params.id,
        target,
        sourceRevision,
        targetRevision
      });
      targetId = result.target.id;
    } catch (cause) {
      if (cause instanceof ContributorMergeError) {
        return fail(cause.status, { message: cause.message });
      }
      if (cause instanceof CatalogUnavailableError) {
        return fail(503, { message: cause.message });
      }
      console.error('[admin] contributor merge failed', cause);
      return fail(500, { message: 'the merge failed and was rolled back' });
    }

    redirect(303, `/admin/contributor/${targetId}/edit`);
  }
};
