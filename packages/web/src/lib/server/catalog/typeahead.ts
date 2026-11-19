/**
 * Prefix completion for the search field, over the same edition views the
 * search results use.
 *
 * Postgres answers by default: `searchEditions` already matches partial titles
 * and contributor names through its `ILIKE` branches. The external index only
 * takes over when `SEARCH_BACKEND=tantivy` and `SEARCH_URL` is set, and any
 * engine failure falls back to Postgres so the field never goes blank because
 * the index is restarting.
 */

import { editionsByUris, searchEditions } from './books.ts';
import { engineConfig, parseSearchBackend, typeaheadEngineUris } from './search-engine.ts';
import type { BookQueryable, BookView } from './book-view.ts';

export interface TypeaheadInput {
  q: string;
  limit: number;
  coversBaseUrl?: string;
}

export interface TypeaheadResult {
  items: BookView[];
  outcome: 'ok' | 'engine_fallback';
}

/** Engine uris in rank order, or undefined when Postgres must answer. */
async function engineTypeaheadUris(
  input: TypeaheadInput,
  source: Record<string, string | undefined>,
  engineFetch: typeof fetch
): Promise<string[] | undefined> {
  const engine = engineConfig(source);
  if (parseSearchBackend(source.SEARCH_BACKEND) !== 'tantivy' || engine.url === undefined) {
    return undefined;
  }
  try {
    return await typeaheadEngineUris(
      { q: input.q, limit: input.limit },
      { url: engine.url, timeoutMs: engine.timeoutMs, fetchImpl: engineFetch }
    );
  } catch (error) {
    console.error('[xrpc] search typeahead engine failed, falling back to Postgres', error);
    return undefined;
  }
}

export async function typeaheadEditions(
  input: TypeaheadInput,
  pool: BookQueryable,
  source: Record<string, string | undefined>,
  engineFetch: typeof fetch = fetch
): Promise<TypeaheadResult> {
  const uris = await engineTypeaheadUris(input, source, engineFetch);
  if (uris !== undefined) {
    // Hydration is deliberately outside the engine `try`: a hydration failure
    // is a catalog failure, not an engine failure, so it must propagate.
    return {
      items: await editionsByUris(uris, pool, input.coversBaseUrl ?? ''),
      outcome: 'ok'
    };
  }
  const results = await searchEditions(
    {
      q: input.q,
      identifiers: [],
      offset: 0,
      limit: input.limit,
      coversBaseUrl: input.coversBaseUrl
    },
    pool
  );
  return {
    items: results.items,
    outcome:
      parseSearchBackend(source.SEARCH_BACKEND) === 'tantivy' &&
      engineConfig(source).url !== undefined
        ? 'engine_fallback'
        : 'ok'
  };
}
