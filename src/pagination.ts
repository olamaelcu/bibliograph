export interface PageResult {
  limit: number;
  offset: number;
}

export function parsePagination(
  limit: string | undefined,
  cursor: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): PageResult {
  const parsed = parseInt(limit || '');
  const lim = Number.isNaN(parsed)
    ? defaultLimit
    : Math.min(Math.max(1, parsed), maxLimit);
  const offset = cursor ? parseInt(cursor) || 0 : 0;
  return { limit: lim, offset };
}

export function nextCursor(count: number, offset: number, limit: number): string | undefined {
  return count === limit ? String(offset + limit) : undefined;
}

// ─── Keyset (cursor-based) pagination ────────────────────────────────────────
//
// Why: `LIMIT N OFFSET M` becomes O(M) on the wire once M is large, even with
// the right covering index — SQLite still has to stream M rows before it can
// emit the next page. The keyset form (`WHERE (sortKey, tiebreaker) > (?, ?)`)
// turns pagination into O(1) per page. For the books listing, the sort key is
// `(createdAt, uri)`; the `(status, createdAt, uri)` composite index covers
// both the filter and the order, so the query stays index-only.

export interface KeysetPageResult {
  limit: number;
  cursor?: KeysetCursor;
}

export interface KeysetCursor {
  c: string;
  u: string;
}

export function parseKeysetPagination(
  limit: string | undefined,
  cursor: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): KeysetPageResult {
  const parsed = parseInt(limit || '');
  const lim = Number.isNaN(parsed)
    ? defaultLimit
    : Math.min(Math.max(1, parsed), maxLimit);
  let decoded: KeysetCursor | undefined;
  if (cursor) {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
      const obj = JSON.parse(raw);
      if (typeof obj?.c === 'string' && typeof obj?.u === 'string') {
        decoded = { c: obj.c, u: obj.u };
      }
    } catch {
      decoded = undefined;
    }
  }
  return { limit: lim, cursor: decoded };
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

export function nextKeysetCursor<T extends { createdAt: string; uri: string }>(
  rows: T[],
  limit: number,
): string | undefined {
  if (rows.length < limit) return undefined;
  const last = rows[rows.length - 1];
  return encodeKeysetCursor({ c: last.createdAt, u: last.uri });
}