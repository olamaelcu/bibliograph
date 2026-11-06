import type { Logger } from 'pino';
import {
  GoodreadsBlockedError,
  fetchGoodreadsBookById,
  fetchGoodreadsSearch,
} from '../api/goodreads';
import { resolveContributorsByName } from '../api/contributor-name-resolver';
import { isbnIdentifier } from '../identifiers';
import { grEditionUri } from '../gr/keys';
import type { EditionItem } from './types';

/**
 * Goodreads title search, resolved down to ISBNs.
 *
 * The general {@link GoodreadsSource} maps search hits without an ISBN: the
 * search page names a book but not its edition. A hit's own page does carry
 * `isbn13`/`isbn10`, so this lookup fetches the top hits' pages (bounded by
 * `limit`) and keeps the ones with a usable ISBN. It is intentionally separate
 * from the discovery source: here a missing ISBN is a miss, not a result.
 */
export async function searchGoodreadsIsbnCandidates(
  query: string,
  log: Logger,
  limit = 5,
  signal?: AbortSignal,
): Promise<EditionItem[]> {
  const value = query.trim();
  if (value === '') return [];

  try {
    const result = await fetchGoodreadsSearch(value, limit, signal);
    if (!result) return [];
    const createdAt = new Date().toISOString();

    const resolved = await Promise.all(
      result.hits.slice(0, limit).map(async (hit): Promise<EditionItem | null> => {
        const book = await fetchGoodreadsBookById(hit.id, signal).catch(() => null);
        const isbn = isbnIdentifier(book?.isbn13 ?? book?.isbn10 ?? '');
        if (!book || !isbn) return null;
        const contributors = await resolveContributorsByName(hit.authors, 'goodreads', log);
        return {
          uri: grEditionUri(hit.id),
          title: book.title ?? hit.title,
          publishedYear: book.publishedYear ?? hit.publishedYear,
          identifiers: [isbn],
          contributors,
          createdAt,
        };
      }),
    );
    return resolved.filter((item): item is EditionItem => item !== null);
  } catch (err) {
    if (err instanceof GoodreadsBlockedError) {
      log.warn({ stage: 'goodreads-isbn', status: err.status, q: value }, 'goodreads blocked isbn search');
      return [];
    }
    log.warn({ stage: 'goodreads-isbn', err, q: value }, 'goodreads isbn search failed');
    return [];
  }
}
