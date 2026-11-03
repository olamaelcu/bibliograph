#!/usr/bin/env tsx
//
// Retire the book uris that records still name but the catalog no longer has.
//
// Livtet users' shelving and review records carry the book uri they were written
// with. Older ones carry a dash-separated key (`gb-…`) under the pre-`biblio`
// collection or `did:web:localhost`, so `getBooks`/`getEdition` answer 404 and the
// shelf tile, review body and permalink lose their book — while the same book
// sits in the catalog under its dotted key.
//
// This walks every book reference in the local `records` mirror, derives the
// catalog uri for each (`legacy-book-uri.ts`), and records an alias
// (`edition_aliases`) when that uri exists — after which every read path resolves
// the retired uri to the book that absorbed it. Idempotent: a uri that is live or
// already aliased is skipped, so re-running writes nothing.
//
//   pnpm exec tsx scripts/backfill-legacy-book-refs.ts --dry-run
//   pnpm exec tsx scripts/backfill-legacy-book-refs.ts
//
// Requires DATABASE_URL. Prints a JSON summary on stdout; exits 1 when a
// reference could not be placed, since that is a book someone shelved and the
// catalog cannot answer for.

import { inArray, sql } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { editions, editionAliases, records } from '../src/lib/server/db/schema';
import { canonicalEditionUri, isCanonicalEditionUri } from '../src/lib/server/legacy-book-uri';

interface Options {
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  let limit = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') continue;
    if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
      continue;
    }
    if (arg === '--limit') {
      limit = Number(argv[i + 1]);
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(limit) || limit < 0) throw new Error('--limit must be zero or a positive number');
  return { dryRun: argv.includes('--dry-run'), limit };
}

/**
 * Every book reference the mirror holds, in any shape a writer has used: the
 * lexicon's `book.uri`, the older `book.ref`, and a bare string `book`.
 */
async function bookRefs(limit: number): Promise<string[]> {
  const rows = await db
    .select({
      uri: sql<string | null>`COALESCE(
        ${records.value}->'book'->>'uri',
        ${records.value}->'book'->>'ref',
        CASE WHEN jsonb_typeof(${records.value}->'book') = 'string' THEN ${records.value}->>'book' END
      )`,
    })
    .from(records)
    .where(sql`${records.value} ? 'book'`)
    .groupBy(sql`1`);

  const uris = rows.map((row) => row.uri).filter((uri): uri is string => typeof uri === 'string' && uri !== '');
  return limit > 0 ? uris.slice(0, limit) : uris;
}

async function run(): Promise<void> {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const refs = await bookRefs(limit);

  const live = new Set<string>();
  const aliased = new Set<string>();
  for (let start = 0; start < refs.length; start += 1000) {
    const batch = refs.slice(start, start + 1000);
    const liveRows = await db.select({ uri: editions.uri }).from(editions).where(inArray(editions.uri, batch));
    for (const row of liveRows) live.add(row.uri);
    const aliasRows = await db
      .select({ uri: editionAliases.uri })
      .from(editionAliases)
      .where(inArray(editionAliases.uri, batch));
    for (const row of aliasRows) aliased.add(row.uri);
  }

  const retired: Array<{ uri: string; canonical: string }> = [];
  const unreadable: string[] = [];
  const unplaced: string[] = [];

  for (const uri of refs) {
    if (live.has(uri) || aliased.has(uri)) continue;
    const canonical = canonicalEditionUri(uri);
    if (canonical === null) {
      unreadable.push(uri);
      continue;
    }
    // A retired uri whose key is already the catalog's: the row is simply gone
    // (deleted, or never ingested here), and there is nothing to point it at.
    if (isCanonicalEditionUri(uri)) continue;
    retired.push({ uri, canonical });
  }

  const canonicalUris = [...new Set(retired.map((entry) => entry.canonical))];
  const targetTid = new Map<string, string>();
  for (let start = 0; start < canonicalUris.length; start += 1000) {
    const batch = canonicalUris.slice(start, start + 1000);
    const rows = await db
      .select({ uri: editions.uri, tid: editions.tid })
      .from(editions)
      .where(inArray(editions.uri, batch));
    for (const row of rows) targetTid.set(row.uri, row.tid);
  }

  const writable = retired.filter((entry) => targetTid.has(entry.canonical));
  for (const entry of retired) {
    if (!targetTid.has(entry.canonical)) unplaced.push(entry.uri);
  }

  if (!dryRun && writable.length > 0) {
    await db
      .insert(editionAliases)
      .values(writable.map((entry) => ({ uri: entry.uri, tid: targetTid.get(entry.canonical)! })))
      .onConflictDoUpdate({ target: editionAliases.uri, set: { tid: sql`excluded.tid` } });
  }

  const summary = {
    refs: refs.length,
    live: live.size,
    alreadyAliased: aliased.size,
    aliased: writable.length,
    unplaced: unplaced.length,
    unreadable: unreadable.length,
    dryRun,
  };
  console.log(JSON.stringify(summary));
  for (const uri of unplaced.slice(0, 20)) console.log(`[unplaced] ${uri}`);
  for (const uri of unreadable.slice(0, 20)) console.log(`[unreadable] ${uri}`);

  // A book someone shelved that the catalog cannot answer for is a bug report,
  // not a warning: let the operator see it as a failure.
  if (unplaced.length > 0 || unreadable.length > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('[backfill-legacy-book-refs] failed:', err);
  process.exit(1);
});
