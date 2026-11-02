// Keyset cursor for the recency listings.
//
// Offset paging under "newest first" is wrong by construction: a record indexed
// between two requests shifts every later row, so page two repeats or skips
// entries. The recency reads therefore page by key set — the `(indexed_at, uri)`
// pair of the last row handed out.

export interface RecentCursor {
  indexedAt: Date;
  uri: string;
}

export function encodeRecentCursor(indexedAt: Date, uri: string): string {
  return Buffer.from(JSON.stringify({ t: indexedAt.toISOString(), u: uri }), 'utf8').toString('base64url');
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
  const indexedAt = new Date(t);
  if (Number.isNaN(indexedAt.getTime())) return undefined;
  return { indexedAt, uri: u };
}
