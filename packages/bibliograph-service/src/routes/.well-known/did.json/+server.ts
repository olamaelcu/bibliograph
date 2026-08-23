import { json } from '@sveltejs/kit';
import { getDidDocument } from '$lib/server/did';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  return json(getDidDocument(), {
    headers: {
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
};
