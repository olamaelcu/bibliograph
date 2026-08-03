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
