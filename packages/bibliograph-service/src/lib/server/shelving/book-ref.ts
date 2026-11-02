// The catalog edition a shelving-shaped record points at, across every shape
// writers have left behind.
//
// The lexicon declares `book` as a strongRef (`{uri, cid}`), but production holds
// thousands of records written as `book: {ref, title}` and a few with a bare
// at-uri string. Readers used to take `uri` only and fall back to the rkey, which
// worked while `ref` and rkey happened to agree — that is a coincidence, not a
// contract. This is the one accessor, so hydration, the PDS scans and the SQL
// predicates cannot disagree about which edition a row names.
//
// The records themselves cannot be repaired from here: they are on their
// authors' PDSes and this service is read-only, so accepting them is the fix.

export const EDITION_COLLECTION = 'community.lexicon.book.edition';

function editionUri(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.startsWith('at://')) return null;
  if (!candidate.includes(`/${EDITION_COLLECTION}/`)) return null;
  return candidate;
}

/**
 * `book.uri`, `book.ref`, or a bare `book` string — in that order of preference —
 * but only when the value really names a catalog edition. One repo still holds a
 * `ref` pointing at `did:web:localhost/net.olamaelcu.livtet.biblio.book/…`, a
 * collection that never existed; accepting it would hide the rkey fallback that
 * is the only chance such a row has.
 */
export function bookUriFromValue(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const book = record.book;
  if (typeof book === 'string') return editionUri(book);
  if (book === null || typeof book !== 'object') return null;
  if ('uri' in book) {
    const fromUri = editionUri(book.uri);
    if (fromUri) return fromUri;
  }
  if ('ref' in book) return editionUri(book.ref);
  return null;
}
