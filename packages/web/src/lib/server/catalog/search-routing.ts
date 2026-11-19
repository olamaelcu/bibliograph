/**
 * The switch between the Postgres search and the external index, plus the
 * shadow comparison that gates the flip.
 *
 * Postgres stays authoritative: `shadow` serves Postgres and only records the
 * overlap, `tantivy` serves the index and falls back to Postgres on any engine
 * failure, and bodies that carry identifiers always take the Postgres path
 * (that is a resolve lookup, not a text query, and merging two ranked lists
 * under one offset would silently change the order).
 */

import { metrics, recordCatalogQuery, recordCatalogSearchOverlap } from '../metrics.ts';
import { engineConfig, parseSearchBackend, searchEngineUris, topOverlap } from './search-engine.ts';
import { editionsByUris, searchEditions } from './books.ts';
import type { BookQueryable, BookResults, Identifier } from './book-view.ts';
import type { BookSort, BookSortOrder } from './books.ts';

export interface RoutedSearchInput {
  q?: string;
  title?: string;
  author?: string;
  language?: string;
  identifiers: Identifier[];
  offset: number;
  limit: number;
  sort?: BookSort;
  order?: BookSortOrder;
  coversBaseUrl?: string;
}

/**
 * Answer one `searchEditions` request with whatever `SEARCH_BACKEND` names.
 *
 * A shadow failure or an engine failure never reaches the caller: the Postgres
 * result is returned and the outcome is recorded.
 */
export async function searchEditionsRouted(
  input: RoutedSearchInput,
  pool: BookQueryable,
  source: Record<string, string | undefined>
): Promise<BookResults> {
  const backend = parseSearchBackend(source.SEARCH_BACKEND);
  const engine = engineConfig(source);
  const postgres = () => searchEditions(input, pool);
  if (backend === 'postgres' || engine.url === undefined || input.identifiers.length > 0) {
    return postgres();
  }

  if (backend === 'shadow') {
    const authoritative = await postgres();
    try {
      const engineResult = await searchEngineUris(
        {
          q: input.q,
          title: input.title,
          author: input.author,
          language: input.language,
          sort: input.sort,
          order: input.order,
          offset: input.offset,
          limit: input.limit
        },
        { url: engine.url, timeoutMs: engine.timeoutMs }
      );
      // An edition view's own uri lives in its atproto identifier.
      const authoritativeUris = authoritative.items
        .map((view) => view.identifiers.find((identifier) => identifier.issuer === 'atproto')?.value)
        .filter((uri): uri is string => typeof uri === 'string' && uri !== '');
      recordCatalogSearchOverlap(metrics, topOverlap(engineResult.uris, authoritativeUris));
    } catch (error) {
      console.error('[xrpc] search shadow engine failed', error);
    }
    return authoritative;
  }

  const started = performance.now();
  try {
    const engineResult = await searchEngineUris(
      {
        q: input.q,
        title: input.title,
        author: input.author,
        language: input.language,
        sort: input.sort,
        order: input.order,
        offset: input.offset,
        limit: input.limit
      },
      { url: engine.url, timeoutMs: engine.timeoutMs }
    );
    const items = await editionsByUris(engineResult.uris, pool, input.coversBaseUrl ?? '');
    return { items, hasMore: engineResult.hasMore, total: engineResult.total };
  } catch (error) {
    console.error('[xrpc] search engine failed, falling back to Postgres', error);
    recordCatalogQuery(
      metrics,
      'searchEditions',
      'engine_fallback',
      (performance.now() - started) / 1000
    );
    return postgres();
  }
}
