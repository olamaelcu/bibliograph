import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { ReportQueryError, runReportFrom } from '$lib/server/admin/reports';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * One read-only report page: `?limit=&offset=` plus the report's own filters.
 * Unknown report ids answer 404, invalid filters 400, and an unreachable
 * catalog 503. The query only ever reads the catalog tables.
 */
export const GET: RequestHandler = async ({ cookies, params, url }) => {
  requireAdmin(cookies);

  try {
    const result = await runReportFrom(catalogPool(), params.report, url.searchParams);
    return json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ReportQueryError) {
      return json(
        { error: error.code, message: error.message, field: error.field },
        { status: error.status, headers: NO_STORE }
      );
    }
    if (error instanceof CatalogUnavailableError) {
      return json(
        { error: 'ServiceUnavailable', message: error.message },
        { status: 503, headers: NO_STORE }
      );
    }
    console.error('[admin] report query failed', error);
    return json(
      { error: 'ServiceUnavailable', message: 'report query failed' },
      { status: 503, headers: NO_STORE }
    );
  }
};
