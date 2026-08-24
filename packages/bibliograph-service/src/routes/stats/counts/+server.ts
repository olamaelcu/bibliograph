import { fetchCounts } from '$lib/server/stats';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const counts = await fetchCounts();
  return new Response(JSON.stringify(counts), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};