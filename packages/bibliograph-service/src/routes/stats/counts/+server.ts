import { fetchCountsCached } from '$lib/server/stats';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  // Cached for the same window the memo covers: the poll's answer is a tab
  // label, and recomputing four `count(*)` scans per request is what made this
  // the one unmetered DB path a browser could drive.
  const counts = await fetchCountsCached();
  return new Response(JSON.stringify(counts), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
    },
  });
};
