import { searchService } from '$lib/server/xrpc-router';
import { fail, redirect } from '@sveltejs/kit';
import { deleteEditionAndLinkedWork } from '$lib/server/catalog-delete';
import { isAdministrator } from '$lib/server/labeler/labels';
import type { PageServerLoad } from './$types';
import { PUBLISHER_DID } from '$lib/server/did';
import { workRkey } from '$lib/edition-votes';

export type SearchKind = 'editions' | 'works' | 'contributors' | 'publishers';

const KINDS: readonly SearchKind[] = ['editions', 'works', 'contributors', 'publishers'];

function isKind(v: string | null): v is SearchKind {
  return v !== null && (KINDS as readonly string[]).includes(v);
}

export const load: PageServerLoad = async ({ url, locals }) => {
  const rawKind = url.searchParams.get('kind');
  const kind: SearchKind = isKind(rawKind) ? rawKind : 'editions';
  const q = url.searchParams.get('q') ?? undefined;
  const id = url.searchParams.getAll('id');
  const cursor = url.searchParams.get('cursor') ?? undefined;

  const baseQuery = { q, id: id.length > 0 ? id : undefined, limit: 20, cursor };
  let items: unknown[] = [];
  let nextCursor: string | undefined;
  let total: number | undefined;

  if (kind === 'editions') {
    const r = await searchService.searchEditions(baseQuery);
    items = r.items; nextCursor = r.cursor; total = r.total;
  } else if (kind === 'works') {
    const r = await searchService.searchWorks(baseQuery);
    items = r.items; nextCursor = r.cursor; total = r.total;
  } else if (kind === 'contributors') {
    const r = await searchService.searchContributors(baseQuery);
    items = r.items; nextCursor = r.cursor; total = r.total;
  } else if (kind === 'publishers') {
    const r = await searchService.searchPublishers(baseQuery);
    items = r.items; nextCursor = r.cursor; total = r.total;
  }

  return { kind, q, items, cursor: nextCursor, total, ids: id, canDelete };
};

export const actions = {
  deleteEdition: async ({ locals, request }) => {
    if (!locals.viewer || !(await isAdministrator(locals.viewer.did))) {
      redirect(303, '/login?next=/search');
    }
    const data = await request.formData();
    const uri = String(data.get('uri') ?? '').trim();
    if (!uri) return fail(400, { error: 'No record specified.' });
    const rkey = workRkey(uri);
    await deleteEditionAndLinkedWork(rkey);
    return { ok: true, deleted: rkey };
  },
};
  const viewerDid = locals.viewer?.did ?? null;
  const canDelete = viewerDid ? await isAdministrator(viewerDid) : false;
