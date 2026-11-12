import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ReportRegistryResponse } from '$lib/admin/types';
import { requireAdmin } from '$lib/server/admin/auth';
import { reportSummaries } from '$lib/server/admin/reports';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** The report registry: ids, titles, filters and column definitions. */
export const GET: RequestHandler = ({ cookies }) => {
  requireAdmin(cookies);
  const response: ReportRegistryResponse = { reports: reportSummaries() };
  return json(response, { headers: NO_STORE });
};
