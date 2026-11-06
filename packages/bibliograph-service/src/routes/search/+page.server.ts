import { searchService } from '$lib/server/xrpc-router';
import { error, fail, redirect } from '@sveltejs/kit';
import { deleteEditionAndLinkedWork } from '$lib/server/catalog-delete';
import { isAdministrator } from '$lib/server/labeler/librarian';
import { allowRequest } from '$lib/server/rate-limit';
import type { PageServerLoad } from './$types';
import { workRkey } from '$lib/edition-votes';

export type SearchKind = 'editions' | 'works' | 'contributors' | 'publishers';

const KINDS: readonly SearchKind[] = ['editions', 'works', 'contributors', 'publishers'];

function isKind(v: string | null): v is SearchKind {
  return v !== null && (KINDS as readonly string[]).includes(v);
}

/** Lexicon type stamped on every result so the page can render per-kind affordances. */
const ITEM_TYPE: Record<SearchKind, string> = {
  editions: 'community.lexicon.book.edition',
  works: 'community.lexicon.book.work',
  contributors: 'community.lexicon.book.contributor',
  publishers: 'community.lexicon.book.publisher',
};

/** Per-IP budget for the storefront search page, in requests per minute. */
const SEARCH_PAGE_RPM = 10;

export const load: PageServerLoad = async ({
  url,
  locals,
  getClientAddress,
}) => {
  // This page calls `searchService` directly in SSR, bypassing the XRPC
  // middleware chain and its limiter. Without this guard the storefront is an
  // unmetered path to the paid upstream search providers (Google Books,
  // ISBNdb, Wikidata), so it gets a tighter budget than the
  // XRPC default.
  if (!allowRequest(getClientAddress(), 'page:/search', SEARCH_PAGE_RPM)) {
    throw error(429, 'Too many searches. Try again in a minute.');
  }
  const viewerDid = locals.viewer?.did ?? null;
  const canDelete = viewerDid ? await isAdministrator(viewerDid) : false;
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

  // Sources are kind-agnostic (no `$type`), but the results list branches on it
  // to pick covers vs portraits. Stamp it once here so no source has to know
  // about presentation.
  const typed = items.map((item) => ({ ...(item as Record<string, unknown>), $type: ITEM_TYPE[kind] }));

  return { kind, q, items: typed, cursor: nextCursor, total, ids: id, canDelete };
};

export const actions = {
  deleteEdition: async ({ locals, request }) => {
    if (!locals.viewer || !(await isAdministrator(locals.viewer.did))) {
      redirect(303, '/login?next=/search');
    }
    const formData = await request.formData();
    const uri = String(formData.get('uri') ?? '').trim();
    if (!uri) return fail(400, { error: 'No record specified.' });
    const rkey = workRkey(uri);
    await deleteEditionAndLinkedWork(rkey);
    return { ok: true, deleted: rkey };
  },
};
