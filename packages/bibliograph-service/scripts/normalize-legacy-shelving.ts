#!/usr/bin/env tsx
//
// Repair the mirrored `bookShelving` rows that were written before the lexicon
// declared `book` as a strongRef.
//
// The published shape is `book: { uri, cid }`. Production still holds 2,822 rows
// written as `book: { ref, title, contributors }` — an expanded-ref experiment
// that no reader is meant to understand, and that the mirror SQL predicates
// (`value->'book'->>'uri'`) cannot see. Rather than teach every reader a second
// shape, this rewrites the mirrored value to the declared one, taking the `cid`
// from the catalog row the record points at.
//
// The records on their authors' PDSes are untouched: this service is read-only
// and those repos are not ours. What changes is our copy, which is what the
// queries and hydrators read.
//
// Idempotent: a repaired row has both `uri` and `cid`, so it is no longer a
// candidate. Rows whose book cannot be resolved to a catalog edition are
// reported and skipped — `backfill-shelving-editions` fills those, and this
// script can be re-run after it.
//
//   pnpm exec tsx scripts/normalize-legacy-shelving.ts --dry
//   pnpm exec tsx scripts/normalize-legacy-shelving.ts            # repair everything
//   pnpm exec tsx scripts/normalize-legacy-shelving.ts --limit=500
//
// Requires DATABASE_URL.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { editions, records } from '../src/lib/server/db/schema';
import { catalogEditionUriFromRkey } from '../src/lib/server/shelving/catalog-uri';
import { SHELVING_COLLECTION } from '../src/lib/server/shelving/shelvers';
import { createLogger } from '../src/lib/server/logger';

const log = createLogger('web');

const PAGE_SIZE = 500;
const EDITION_COLLECTION = 'community.lexicon.book.edition';

interface Args {
  dry: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dry: false };
  for (const arg of argv) {
    if (arg === '--dry') args.dry = true;
    else if (arg.startsWith('--limit=')) args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    console.error('--limit must be a positive integer');
    process.exit(1);
  }
  return args;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function editionUri(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.startsWith('at://')) return null;
  return candidate.includes(`/${EDITION_COLLECTION}/`) ? candidate : null;
}

/**
 * The edition a row points at, in order of authority: the declared `uri`, the
 * legacy `ref`, then the rkey the writer derived it from. Only an edition at-uri
 * counts — one row's `ref` names `did:web:localhost/…/biblio.book/`, a collection
 * that never existed, and must not be mistaken for a book.
 */
function targetEditionUri(rkey: string, value: unknown): string | null {
  const book = asRecord(asRecord(value).book);
  return editionUri(book.uri) ?? editionUri(book.ref) ?? catalogEditionUriFromRkey(rkey);
}

const stats = {
  scanned: 0,
  repaired: 0,
  alreadyStrongRef: 0,
  noEdition: 0,
  noCatalogRow: 0,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let cursor: string | undefined;
  let processed = 0;

  for (;;) {
    const pageSize = args.limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, args.limit - processed);
    if (pageSize <= 0) break;

    const rows = await db
      .select({ uri: records.uri, rkey: records.rkey, value: records.value })
      .from(records)
      .where(
        and(
          eq(records.collection, SHELVING_COLLECTION),
          cursor ? sql`${records.uri} > ${cursor}` : undefined,
          // Candidates are rows the declared readers cannot see: no `book.uri`,
          // or a `uri` whose strongRef is missing its `cid`.
          sql`(${records.value}->'book'->>'uri' IS NULL OR ${records.value}->'book'->>'cid' IS NULL)`,
        ),
      )
      .orderBy(records.uri)
      .limit(pageSize);
    if (rows.length === 0) break;

    const wanted = new Map<string, { uri: string; rkey: string; value: unknown; edition: string }>();
    for (const row of rows) {
      const edition = targetEditionUri(row.rkey, row.value);
      if (!edition) {
        stats.noEdition++;
        log.warn({ uri: row.uri, rkey: row.rkey }, 'legacy shelving row names no catalog edition; left as is');
        continue;
      }
      wanted.set(row.uri, { uri: row.uri, rkey: row.rkey, value: row.value, edition });
    }

    const cids = new Map<string, string>();
    if (wanted.size > 0) {
      const catalog = await db
        .select({ uri: editions.uri, cid: editions.cid })
        .from(editions)
        .where(inArray(editions.uri, [...new Set([...wanted.values()].map((row) => row.edition))]));
      for (const row of catalog) cids.set(row.uri, row.cid);
    }

    for (const row of wanted.values()) {
      const cid = cids.get(row.edition);
      if (!cid) {
        stats.noCatalogRow++;
        log.warn({ uri: row.uri, edition: row.edition }, 'no catalog row for the edition; run backfill:shelving-editions');
        continue;
      }
      const value = asRecord(row.value);
      const book = asRecord(value.book);
      if (book.uri === row.edition && book.cid === cid) {
        stats.alreadyStrongRef++;
        continue;
      }
      if (args.dry) {
        stats.repaired++;
        continue;
      }
      // The strongRef is exactly `{uri, cid}`; the legacy extras (`title`,
      // `contributors`) are dropped because the lexicon does not declare them.
      const next = { ...value, book: { uri: row.edition, cid } };
      await db.update(records).set({ value: next }).where(eq(records.uri, row.uri));
      stats.repaired++;
    }

    stats.scanned += rows.length;
    processed += rows.length;
    cursor = rows[rows.length - 1]?.uri;
    log.info({ scanned: stats.scanned, repaired: stats.repaired, dry: args.dry }, 'page done');
    if (args.limit !== undefined && processed >= args.limit) break;
    if (rows.length < pageSize) break;
  }

  log.info(stats, args.dry ? 'dry run: nothing written' : 'repair complete');
  await db.$client.end();
}

await main();
