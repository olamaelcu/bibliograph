import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AdminEntityMatch, AdminEntitySearchResponse, Identifier } from '$lib/admin/types';
import { requireAdmin } from '$lib/server/admin/auth';
import { catalogPool } from '$lib/server/catalog/db';
import { CatalogUnavailableError } from '$lib/server/catalog/errors';
import { likePattern } from '$lib/server/catalog/sql';

const NO_STORE = { 'cache-control': 'no-store' } as const;

type EntityRow = {
  id: string;
  name: string;
  identifiers: Identifier[] | null;
  at_uri: string | null;
};

/** Typeahead over local contributor/publisher rows for the editor's picker. */
export const GET: RequestHandler = async ({ cookies, url }) => {
  requireAdmin(cookies);

  const type = url.searchParams.get('type');
  if (type !== 'contributor' && type !== 'publisher') {
    return json(
      { error: 'BadRequest', message: 'type must be contributor or publisher' },
      { status: 400, headers: NO_STORE }
    );
  }
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query === '') {
    const empty: AdminEntitySearchResponse = { type, query, items: [] };
    return json(empty, { headers: NO_STORE });
  }
  if (query.length > 200) {
    return json(
      { error: 'BadRequest', message: 'q must be at most 200 characters' },
      { status: 400, headers: NO_STORE }
    );
  }
  const rawLimit = Number(url.searchParams.get('limit') ?? '15');
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 25) : 15;
  const table = type === 'contributor' ? 'contributors' : 'publishers';

  try {
    const result = await catalogPool().query<EntityRow>(
      `SELECT id, name, identifiers, at_uri
         FROM ${table}
        WHERE name ILIKE $1 ESCAPE '\\'
           OR identifiers::text ILIKE $1 ESCAPE '\\'
        ORDER BY name, id
        LIMIT $2`,
      [likePattern(query), limit]
    );
    const items: AdminEntityMatch[] = result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      identifiers: row.identifiers ?? [],
      ref: row.at_uri
    }));
    const response: AdminEntitySearchResponse = { type, query, items };
    return json(response, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      return json(
        { error: 'ServiceUnavailable', message: error.message },
        { status: 503, headers: NO_STORE }
      );
    }
    console.error('[admin] entity typeahead failed', error);
    return json(
      { error: 'ServiceUnavailable', message: 'catalog lookup failed' },
      { status: 503, headers: NO_STORE }
    );
  }
};
