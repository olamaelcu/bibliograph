/**
 * Pure SQL/text helpers for the catalog read path.
 *
 * No SvelteKit imports: this module is exercised by node tests and imported by
 * both the edition and entity queries.
 */

/** `%value%` with LIKE metacharacters escaped, for an ILIKE substring match. */
export function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

/** `value%` with LIKE metacharacters escaped, for an ILIKE prefix match. */
export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Offset cursors are base64url JSON `{ "o": <offset> }`, the same shape the
 * activity surface uses. A malformed cursor decodes to 0 rather than erroring,
 * and the offset is floored and capped before it reaches Postgres.
 */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export const MAX_OFFSET = 1_000_000_000;

export function decodeOffsetCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return 0;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  // `in` narrows the parsed JSON object without fabricating a shape: the
  // property is read as `unknown` and validated right here.
  if (!('o' in parsed)) return 0;
  const value = parsed.o;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_OFFSET);
}

/**
 * Keyset cursors are base64url JSON `{ "after": <uri> }`.
 *
 * A keyset page resumes strictly after a row instead of at an offset, so a walk
 * over a catalogue that is still growing never skips a row that an insertion
 * shifted across a page boundary — which is what a crawler would otherwise do
 * at the page it takes next. A malformed cursor decodes to null, i.e. start at
 * the beginning rather than error, matching the offset cursor's contract.
 */
export function encodeKeysetCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), 'utf8').toString('base64url');
}

export function decodeKeysetCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!('after' in parsed)) return null;
  const value = parsed.after;
  return typeof value === 'string' && value !== '' ? value : null;
}
