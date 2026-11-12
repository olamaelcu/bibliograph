import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCatalogStats } from '$lib/server/catalog/stats';

// Same-origin polling endpoint for the docs page; never cache, since the
// counts are meant to move while the tab stays visible.
const NO_STORE = { 'cache-control': 'no-store' } as const;

export const GET: RequestHandler = async () => {
  try {
    return json(await readCatalogStats(), { headers: NO_STORE });
  } catch (error) {
    console.error('[web] stats endpoint failed', error);
    return json({ error: 'ServiceUnavailable' }, { status: 503, headers: NO_STORE });
  }
};
