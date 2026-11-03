// Canonical book identity, resolved for readers.
//
// An edition uri is a provider namespace (`ol.*`, `gb.*`, `bh.*`, `isbndb.*`), so
// one book can be known by several uris: the row a librarian merge kept, plus
// every uri that merge retired (`edition_aliases`). Readers are routinely handed
// those retired uris — a shelving record names whatever the user shelved, and
// clients cache what an endpoint answered last week — so "which book is this"
// must not depend on which of its uris is asked about.
//
// `editions.tid` is that answer, and it is unique, so resolving through it is
// what makes a batch of uris collapse to one record per book instead of one
// record per uri.

import { inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from './db';
import { editionAliases, editions, type EditionRow } from './db/schema';
import type { DbExecutor } from './stats';

/** The handle `db.transaction` hands its callback — a merge writes through it. */
type DbTransaction = Parameters<Parameters<DbExecutor['transaction']>[0]>[0];

/**
 * Map every uri in `uris` to the catalog row that describes that book.
 *
 * A uri naming a live row maps to it; a uri retired by a merge maps to the row
 * that absorbed it. The survivor's own uri is a key too, so a caller that asked
 * only about a retired uri still learns the canonical uri to link at.
 *
 * Unknown uris are absent, never guessed at: each one costs a trip to a provider
 * whose answer may be an entirely different book. Two requested uris that name
 * the same book map to the *same* row object, so callers can dedupe on any field.
 */
export async function resolveEditions(
  uris: readonly string[],
  db: DbExecutor = defaultDb,
): Promise<Map<string, EditionRow>> {
  const resolved = new Map<string, EditionRow>();
  const wanted = [...new Set(uris.filter((uri) => typeof uri === 'string' && uri !== ''))];
  if (wanted.length === 0) return resolved;

  const direct = await db
    .select({ uri: editions.uri, tid: editions.tid })
    .from(editions)
    .where(inArray(editions.uri, wanted));

  const tidByUri = new Map<string, string>();
  for (const row of direct) tidByUri.set(row.uri, row.tid);

  // Only the uris that are not live rows can be aliases, and a live row always
  // wins: a merge that failed to retire a uri must not shadow the row it names.
  const missing = wanted.filter((uri) => !tidByUri.has(uri));
  if (missing.length > 0) {
    const aliased = await db
      .select({ uri: editionAliases.uri, tid: editionAliases.tid })
      .from(editionAliases)
      .where(inArray(editionAliases.uri, missing));
    for (const row of aliased) tidByUri.set(row.uri, row.tid);
  }

  const tids = [...new Set(tidByUri.values())];
  if (tids.length === 0) return resolved;

  // One read for the rows themselves: two uris of the same book share a tid, so
  // this is at most one row per requested book.
  const rows = await db.select().from(editions).where(inArray(editions.tid, tids));
  const rowByTid = new Map(rows.map((row) => [row.tid, row]));

  for (const [uri, tid] of tidByUri) {
    const row = rowByTid.get(tid);
    if (!row) continue;
    resolved.set(uri, row);
    resolved.set(row.uri, row);
  }
  return resolved;
}

/**
 * Which of `uris` the catalog has retired in favour of another book.
 *
 * Ingest asks this before inserting: a record whose uri a merge folded into
 * another book must not come back as a fresh row with a fresh tid, or the
 * duplicate the merge removed reappears on the next ingest of that provider.
 */
export async function aliasedEditionUris(
  uris: readonly string[],
  db: DbExecutor = defaultDb,
): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  const rows = await db
    .select({ uri: editionAliases.uri })
    .from(editionAliases)
    .where(inArray(editionAliases.uri, [...new Set(uris)]));
  return new Set(rows.map((row) => row.uri));
}

/**
 * Retire `uris` in favour of the book `tid`: after this, every one of them
 * resolves to that book's row.
 *
 * Called inside the merge transaction, before the losers are deleted, so a crash
 * cannot leave uris pointing at deleted rows without a redirect. Re-retiring a
 * uri (the same book merged again from a different selection) repoints it.
 */
export async function recordEditionAliases(
  db: DbExecutor | DbTransaction,
  uris: readonly string[],
  tid: string,
): Promise<void> {
  const rows = [...new Set(uris)].map((uri) => ({ uri, tid }));
  if (rows.length === 0) return;
  await db
    .insert(editionAliases)
    .values(rows)
    .onConflictDoUpdate({ target: editionAliases.uri, set: { tid: sql`excluded.tid` } });
}
