import type { PageServerLoad } from './$types';
import { readCatalogStats, type CatalogStats } from '$lib/server/catalog/stats';

/**
 * The docs page is generated from the lexicons and must render even when the
 * catalog database is down, so stats are best-effort: a failure is logged and
 * surfaced as `null` rather than thrown.
 */
export const load: PageServerLoad = async (): Promise<{ stats: CatalogStats | null }> => {
  try {
    return { stats: await readCatalogStats() };
  } catch (error) {
    console.error('[web] catalog stats unavailable', error);
    return { stats: null };
  }
};
