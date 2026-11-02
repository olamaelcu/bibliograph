import type { BacklinkRecord } from '../constellation/client';

/** Collection whose records put a catalog book on one of a user's shelves. */
export const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';

/** Backlink source matching the `book.uri` ref of a bookShelving record. */
export const SHELVING_BACKLINK_SOURCE = 'net.olamaelcu.livtet.biblio.bookShelving:book.uri';

/**
 * The bookShelving rkey is derived from the catalog book URI (last segment after
 * the final `/`), so every user's record for one book shares it — see
 * `lexicons/net/olamaelcu/livtet/biblio/bookShelving.json`. It is therefore
 * recoverable from the book URI alone, and two readers holding different halves
 * of the pair still agree on what they are looking for.
 */
export function shelvingRkeyFor(bookUri: string): string {
  const end = bookUri.lastIndexOf('/');
  return end === -1 ? '' : bookUri.slice(end + 1);
}

const RECORD_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * Distinct DIDs whose bookShelving record carries `shelvingRkey`, in the order
 * the records arrived.
 *
 * Constellation and the local mirror describe the same fact twice: the record
 * URI carries the identity, and a separate `did` field repeats it. The URI wins,
 * because that is what the record is addressed by — a DID field that disagrees
 * with the authority of its own URI is a record we cannot place.
 *
 * Records are also re-checked here rather than trusted from the caller: one
 * backlink page is homogeneous by construction, but mirror rows are selected on
 * a jsonb path and the two are merged, so a stray record of another collection
 * or another rkey would otherwise be reported as a shelver of this book.
 */
export function collectShelverDids(
  shelvingRkey: string,
  records: readonly Pick<BacklinkRecord, 'uri'>[],
): string[] {
  if (!shelvingRkey) return [];
  const dids: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const match = RECORD_URI.exec(record.uri);
    if (!match) continue;
    const [, did, collection, rkey] = match;
    if (!did || collection !== SHELVING_COLLECTION || rkey !== shelvingRkey) continue;
    if (seen.has(did)) continue;
    seen.add(did);
    dids.push(did);
  }
  return dids;
}
