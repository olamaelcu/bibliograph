import { searchService } from '$lib/server/xrpc-router';
import type { PageServerLoad } from './$types';

export type SearchKind = 'editions' | 'works' | 'contributors' | 'publishers';

const KINDS: readonly SearchKind[] = ['editions', 'works', 'contributors', 'publishers'];

function isKind(v: string | null): v is SearchKind {
  return v !== null && (KINDS as readonly string[]).includes(v);
}

export const load: PageServerLoad = async ({ url }) => {
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

  return { kind, q, items, cursor: nextCursor, total, ids: id };
};
