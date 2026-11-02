/**
 * Pure helpers for the TAP record pipeline.
 *
 * Kept out of `handlers.ts` so they can be tested without a database: both the
 * consumer (before it enqueues) and the upsert task (before it writes) need the
 * same two questions answered — "which uri is this record?" and "what does one
 * copy of each uri look like?".
 */

/** One `records` row as TAP hands it to us. */
export interface MirrorRowInput {
  uri: string;
  did: string;
  rkey: string;
  value: Record<string, unknown>;
}

/** An `at://<did>/<collection>/<rkey>` record uri, split. */
export interface RecordUriParts {
  did: string;
  collection: string;
  rkey: string;
}

/**
 * Split a record uri. `null` for anything that is not
 * `at://did:…/<collection>/<rkey>` — a malformed event must not reach the
 * database as a half-parsed row.
 */
export function parseRecordUri(uri: string): RecordUriParts | null {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) return null;
  const [, did, collection, rkey] = match;
  if (!did || !collection || !rkey) return null;
  return { did, collection, rkey };
}

/**
 * One entry per uri, the last one wins.
 *
 * Postgres rejects a multi-row `INSERT … ON CONFLICT DO UPDATE` outright when
 * the statement names the same constrained value twice
 * (`ON CONFLICT DO UPDATE command cannot affect row a second time`), so a single
 * redelivered event inside one batch used to fail the whole batch and dead-letter
 * every record in it. Last-write-wins is the correct collapse: TAP delivers in
 * repo order, so the final event for a uri is the record's current state.
 *
 * The result keeps the position of each uri's first appearance, which keeps the
 * insert order stable without changing which value wins.
 */
export function dedupeByUri<T extends { uri: string }>(items: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const item of items) latest.set(item.uri, item);
  return [...latest.values()];
}

/** Unique record uris, in first-appearance order. */
export function uniqueUris(uris: readonly string[]): string[] {
  return [...new Set(uris)];
}
