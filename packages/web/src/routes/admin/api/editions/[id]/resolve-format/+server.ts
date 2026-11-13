import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/admin/auth';
import { loadEditionForEdit } from '$lib/server/admin/edition-edit';
import {
  FormatResolutionError,
  proxyFormatResolution
} from '$lib/server/admin/format-resolution';
import { readAdminBody } from '$lib/server/admin/request';
import { workerAdminPost } from '$lib/server/admin/worker';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ cookies, params, request }) => {
  requireAdmin(cookies);

  const body = await readAdminBody(request);

  try {
    const result = await proxyFormatResolution({
      body,
      loadIdentifiers: async () => {
        const edition = await loadEditionForEdit(catalogPool(), params.id);
        return edition ? edition.identifiers : null;
      },
      postWorker: (workerBody) => workerAdminPost('/resolve-format', workerBody)
    });
    return json(result.payload, { status: result.status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof FormatResolutionError) {
      return json(
        { error: error.code, message: error.message },
        { status: error.status, headers: NO_STORE }
      );
    }
    if (error instanceof CatalogUnavailableError) {
      return json(
        { error: 'ServiceUnavailable', message: error.message },
        { status: 503, headers: NO_STORE }
      );
    }
    throw error;
  }
};
