// Provider dispatch for catalog editions.
//
// A shelf row (or a review, or a feed entry) carries a catalog URI like
// `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL123W`.
// When that row is missing from `editions`, the only way to fill it is to ask
// the provider that owns the rkey prefix: the aggregator catalogs (OpenLibrary,
// Google Books, ISBNdb) are not published as atproto repos, so there is nothing
// local to copy. Bookhive's catalog *is* an atproto repo, so its editions are
// simply read back by id.
//
// Every fetcher returns an `EditionItem` (`uri`, `identifiers`, `contributors`,
// …) built for the `ingest-edition*` job, so persisting one goes through the
// same code path as a search result and `editionUriFor(identifiers)` always
// derives the same URI the original reference used.

import type { Logger } from 'pino';
import type { EditionItem } from '../search/types';
import { getEditionByRkey } from '../api/open-library';
import { getEditionByVolumeId } from '../api/google-books';
import { getEditionByIsbn } from '../api/isbndb';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import { catalogBookToEdition, fetchCatalogBook } from '../bookhive/catalog';
import { hiveIdFromBhRkey, isBhRkey } from '../bookhive/keys';
import { grIdFromRkey, isGrRkey } from '../gr/keys';
import { fetchGoodreadsEdition } from '../search/goodreads-source';

/** rkey of an edition URI (the last path segment). */
export function editionRkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * Resolve one Bookhive edition on demand from Bookhive's own catalog.
 *
 * `ingest:bookhive` walks the whole catalog in bulk; this is the same mapping
 * for the single hive id a shelf row happens to point at, so an edition does
 * not wait for a full re-ingest to appear on a reader's shelf. The record's
 * author names stay unref'd (see `catalogBookToEdition`), matching what the
 * bulk ingest writes for authors it has no contributor record for.
 *
 * Null for an absent or unmappable record; transport errors are thrown and
 * settled by {@link fetchEditionForUri}.
 */
export async function resolveBookhiveEdition(
  rkey: string,
  signal?: AbortSignal,
): Promise<EditionItem | null> {
  const rec = await fetchCatalogBook(hiveIdFromBhRkey(rkey), signal);
  return rec ? (catalogBookToEdition(rec)?.item ?? null) : null;
}

/**
 * Fetch the edition a catalog URI points at, from the provider that owns its
 * rkey prefix. Returns null when the prefix has no provider wired, when the
 * provider is disabled (missing API key), or when it has no record for the id.
 * Never throws: a provider outage must not fail a shelf page.
 */
export async function fetchEditionForUri(
  uri: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<EditionItem | null> {
  const rkey = editionRkeyOf(uri);
  try {
    if (rkey.startsWith('ol.')) {
      return await getEditionByRkey(rkey, log, signal);
    }
    if (rkey.startsWith('isbndb.')) {
      return await getEditionByIsbn(rkey.slice('isbndb.'.length), log, signal);
    }
    if (isGbRkey(rkey)) {
      return await getEditionByVolumeId(volumeIdFromGbRkey(rkey), log, signal);
    }
    if (isBhRkey(rkey)) {
      return await resolveBookhiveEdition(rkey, signal);
    }
    if (isGrRkey(rkey)) {
      return await fetchGoodreadsEdition(grIdFromRkey(rkey), log, signal);
    }
    log.debug({ stage: 'edition-fetch', uri, rkey }, 'no provider for edition rkey prefix');
    return null;
  } catch (err) {
    log.warn({ stage: 'edition-fetch', uri, err }, 'provider fetch for edition failed');
    return null;
  }
}

/** Provider name for an edition URI, for reporting. `null` when unmapped. */
export function providerForEditionUri(uri: string): 'ol' | 'isbndb' | 'gb' | 'bh' | 'gr' | null {
  const rkey = editionRkeyOf(uri);
  if (rkey.startsWith('ol.')) return 'ol';
  if (rkey.startsWith('isbndb.')) return 'isbndb';
  if (isGbRkey(rkey)) return 'gb';
  if (rkey.startsWith('bh.')) return 'bh';
  if (isGrRkey(rkey)) return 'gr';
  return null;
}
