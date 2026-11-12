import type { AdminEdition } from '$lib/admin/types';
import { catalogPool } from '../catalog/db';
import { loadAdminEditionsFrom, searchAdminEditionsFrom, type Queryable } from './edition-read';

/** Typeahead over local editions by title, at-URI or identifier. */
export async function searchAdminEditions(input: {
  q: string;
  limit?: number;
}): Promise<AdminEdition[]> {
  return searchAdminEditionsFrom(catalogPool(), input);
}

/** Load editions, optionally inside the caller's transaction and row locks. */
export async function loadAdminEditions(
  uris: string[],
  options: { client?: Queryable; forUpdate?: boolean } = {}
): Promise<AdminEdition[]> {
  const client = options.client ?? catalogPool();
  return loadAdminEditionsFrom(client, uris, { forUpdate: options.forUpdate });
}
