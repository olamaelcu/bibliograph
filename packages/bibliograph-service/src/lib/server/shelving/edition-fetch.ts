// Provider dispatch for catalog editions.
//
// A shelf row (or a review, or a feed entry) carries a catalog URI like
// `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL123W`.
// When that row is missing from `editions`, the only way to fill it is to ask
// the provider that owns the rkey prefix — the catalog itself is not published
// as an atproto repo, so there is no upstream record to copy.
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

/** rkey of an edition URI (the last path segment). */
export function editionRkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * Fetch the edition a catalog URI points at, from the provider that owns its
 * rkey prefix. Returns null when the prefix has no provider wired (bookhive),
 * when the provider is disabled (missing API key), or when it has no record for
 * the id. Never throws: a provider outage must not fail a shelf page.
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
    // bookhive (`bh.*`) records have no by-id fetch: their catalogue is the
    // `ingest:bookhive` import, not a queryable provider.
    log.debug({ stage: 'edition-fetch', uri, rkey }, 'no provider for edition rkey prefix');
    return null;
  } catch (err) {
    log.warn({ stage: 'edition-fetch', uri, err }, 'provider fetch for edition failed');
    return null;
  }
}

/** Provider name for an edition URI, for reporting. `null` when unmapped. */
export function providerForEditionUri(uri: string): 'ol' | 'isbndb' | 'gb' | 'bh' | null {
  const rkey = editionRkeyOf(uri);
  if (rkey.startsWith('ol.')) return 'ol';
  if (rkey.startsWith('isbndb.')) return 'isbndb';
  if (isGbRkey(rkey)) return 'gb';
  if (rkey.startsWith('bh.')) return 'bh';
  return null;
}
