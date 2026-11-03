// Retired book uris → the catalog key they mean.
//
// Livtet's older records name their book with a dash-separated provider key
// (`gb-b9AOEAAAQBAJ`), often under the pre-`biblio` collection and even under
// `did:web:localhost` from the development era. The catalog keys those same
// books `gb.b9AOEAAAQBAJ` under `community.lexicon.book.edition`, so a stored
// legacy uri is a reference to a row that will never exist again — the read
// paths answer 404 and the shelf tile, review body and permalink lose their
// book.
//
// Reading those uris forward (`edition-lookup.ts` → `edition_aliases`) is the
// fix; this module is how the alias for each retired uri is derived. Pure, so a
// migration can report what it would write before writing anything.

import { PUBLISHER_DID } from './did';

export const EDITION_COLLECTION = 'community.lexicon.book.edition';

/** Provider keys that used a dash separator, mapped to their catalog name. */
const DASH_TO_PROVIDER: Record<string, string> = {
  gb: 'gb',
  ol: 'ol',
  bh: 'bh',
  isbn: 'isbndb',
  isbndb: 'isbndb',
};

/** Provider keys the catalog stores as `<key>.<id>`. */
const DOTTED_PROVIDERS: Record<string, true> = { gb: true, ol: true, bh: true, isbndb: true };

/** Provider ids are dense: no slash, no query, no second separator. */
const PROVIDER_ID = /^[A-Za-z0-9_:.-]+$/;

/** Last segment of an at-uri, or the input itself when it is a bare key. */
export function rkeyOfUri(uriOrRkey: string): string | null {
  const value = uriOrRkey.trim();
  if (value === '') return null;
  if (!value.startsWith('at://')) return value;
  const match = /^at:\/\/[^/]+\/[^/]+\/([^/?#]+)$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * The rkey the catalog uses for this book, from either spelling.
 *
 * Accepts the canonical spelling too, so a caller can canonicalize
 * unconditionally instead of asking first. Null means "not a book key this
 * service can spell" — the caller must report it, never guess.
 */
export function canonicalEditionRkey(uriOrRkey: string): string | null {
  const rkey = rkeyOfUri(uriOrRkey);
  if (rkey === null) return null;

  const dash = /^([a-z]+)-(.+)$/.exec(rkey);
  if (dash) {
    const [, prefix, id] = dash;
    const provider = prefix === undefined ? undefined : DASH_TO_PROVIDER[prefix];
    if (provider === undefined || id === undefined || !PROVIDER_ID.test(id)) return null;
    return `${provider}.${id}`;
  }

  const dotted = /^([a-z]+)\.(.+)$/.exec(rkey);
  const [, dottedPrefix, dottedId] = dotted ?? [];
  if (
    dottedPrefix !== undefined &&
    dottedId !== undefined &&
    DOTTED_PROVIDERS[dottedPrefix] === true &&
    PROVIDER_ID.test(dottedId)
  ) {
    return rkey;
  }
  return null;
}

/** Catalog edition uri for a book uri/key, or null when the key is unreadable. */
export function canonicalEditionUri(
  uriOrRkey: string,
  publisherDid: string = PUBLISHER_DID,
): string | null {
  const rkey = canonicalEditionRkey(uriOrRkey);
  return rkey === null ? null : `at://${publisherDid}/${EDITION_COLLECTION}/${rkey}`;
}

/** True when `uri` is already the catalog uri for its book. */
export function isCanonicalEditionUri(uri: string, publisherDid: string = PUBLISHER_DID): boolean {
  return canonicalEditionUri(uri, publisherDid) === uri;
}
