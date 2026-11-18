import type { AdminEdition } from '$lib/admin/types';
import { catalogPool } from '../catalog/db';
import { loadAdminBooksFrom, searchAdminBooksFrom, type Queryable } from './book-read';

/** Typeahead over local editions by title, at-URI or identifier. */
export async function searchAdminBooks(input: {
  q: string;
  limit?: number;
}): Promise<AdminEdition[]> {
  return searchAdminBooksFrom(catalogPool(), input);
}

/** Load editions, optionally inside the caller's transaction and row locks. */
export async function loadAdminBooks(
  uris: string[],
  options: { client?: Queryable; forUpdate?: boolean } = {}
): Promise<AdminEdition[]> {
  const client = options.client ?? catalogPool();
  return loadAdminBooksFrom(client, uris, { forUpdate: options.forUpdate });
}
