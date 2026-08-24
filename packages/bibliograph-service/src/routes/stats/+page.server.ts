import { fetchCounts, type Counts } from '$lib/server/stats';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (): Promise<{ counts: Counts }> => {
  return { counts: await fetchCounts() };
};