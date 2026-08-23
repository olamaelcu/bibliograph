import { endpointCounts } from '$lib/server/xrpc-router';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  return { endpointCounts };
};
