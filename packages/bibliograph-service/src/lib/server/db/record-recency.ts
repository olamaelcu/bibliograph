// Feed recency: the record's own `createdAt`, not the mirror's indexing time.
//
// `records.indexed_at` is *when the mirror wrote the row* — a TAP replay, a
// backfill, or a consumer that fell behind reorders it, so a reader sees an old
// post jump to the top of the feed. `value.createdAt` is the instant the writer
// stamped, which is the order a feed claims to have. (`records.created_at` is not
// that value: ingest sets it to `new Date()`.)
//
// The key is the `record_created_at` generated column, never the jsonb expression
// inline: the cast to `timestamptz` is STABLE, so Postgres refuses it in a
// generated column or an index expression, and the regex guard that made casting
// safe turned every feed request into a sequential scan plus a sort of the whole
// table — 45-50 ms locally, and 2-4 s on the loaded production host, against
// 0.19 ms for the index scan the column allows.
//
// Canonical atproto `datetime` values are UTC ISO-8601, whose lexicographic order
// is chronological order. The column is blank for a record carrying none, and a
// blank key sorts after every dated one under `desc`.
//
// `recordSortKeyOf` is the JS side of the same key: a recency cursor is taken from
// a row and compared against the column on the next request, so the two have to
// agree.

import { sql, type SQL } from 'drizzle-orm';
import { records } from './schema';

/**
 * Newest claim first. `uri` breaks ties so the order is total: offset paging
 * needs one slice to answer the same offset twice, and the keyset cursor
 * compares the pair.
 */
export function newestRecordFirst(): SQL {
  return sql`${records.recordCreatedAt} desc, ${records.uri} desc`;
}

/**
 * The same key as `records.record_created_at`, read from a row. jsonb `->>` is
 * the scalar's text, so a non-string scalar is reproduced as text; a record
 * without one gets the blank key the column generates.
 */
export function recordSortKeyOf(row: { value: unknown }): string {
  const raw = (row.value as { createdAt?: unknown } | null | undefined)?.createdAt;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (raw === null || raw === undefined) return '';
  return JSON.stringify(raw);
}
