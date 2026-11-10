import { fetchCountsCached, type Counts } from '$lib/server/stats';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (): Promise<{ counts: Counts }> => {
  // Same memo as the polling endpoint: a page load and a poll landing together
  // must not each run four `count(*)` scans.
  return { counts: await fetchCountsCached() };
};
