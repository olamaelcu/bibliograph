// Keyset cursor for the recency listings.
//
// Offset paging under "newest first" is wrong by construction: a record indexed
// between two requests shifts every later row, so page two repeats or skips
// entries. The recency reads therefore page by key set — the `(createdAt, uri)`
// pair of the last row handed out, where `createdAt` is the record's own claim
// (see `db/record-recency`), not the mirror's indexing time. The cursor has to
// carry the same key the ordering uses, or resuming compares two different
// quantities.

export interface RecentCursor {
  /** The record's own `createdAt` text, exactly as `records.record_created_at`
   *  stores it — blank for a record that carries none. Carried verbatim, because
   *  re-serialising it through `Date` would truncate the fraction and the next
   *  request would compare unlike keys. */
  sortKey: string;
  uri: string;
}

export function encodeRecentCursor(sortKey: string, uri: string): string {
  return Buffer.from(JSON.stringify({ t: sortKey, u: uri }), 'utf8').toString('base64url');
}

/**
 * `undefined` for anything that is not a cursor this module issued — including
 * the bare-offset cursors of the other listings — so a caller treats a malformed
 * cursor as "start from the newest".
 */
export function decodeRecentCursor(cursor: string | undefined): RecentCursor | undefined {
  if (!cursor) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const { t, u } = parsed as { t?: unknown; u?: unknown };
  if (typeof t !== 'string' || typeof u !== 'string' || u.length === 0) return undefined;
  return { sortKey: t, uri: u };
}
