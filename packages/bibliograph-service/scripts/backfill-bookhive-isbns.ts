#!/usr/bin/env tsx
// Copy Bookhive's on-protocol ISBNs into the `bh.*` editions that lack one.
//
// `buzz.bookhive.catalogBook` records carry `identifiers.isbn13` / `isbn10`
// (99% of the catalog has an identifiers object, ~82% an ISBN), but the edition
// mapping only ever emitted the bookhive and goodreads identifiers — so the
// ISBN scan spent upstream searches on rows whose ISBN was already in hand.
// This pass pages the catalog once and merges the ISBN into each matching
// edition, recomputing the record CID.
//
//   node_modules/.bin/tsx scripts/backfill-bookhive-isbns.ts
//   pnpm tsx scripts/backfill-bookhive-isbns.ts --dry
//   pnpm tsx scripts/backfill-bookhive-isbns.ts --pages=5 --limit=500
//
// Idempotent: an edition that already carries an ISBN is skipped, and a catalog
// record without one is a miss, not an error. The enrichment bookkeeping table
// is untouched: the scan excludes rows by ISBN presence, which is what this
// pass changes.

import { eq, inArray } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { fetchCatalogBooksPage } from '../src/lib/server/bookhive/catalog';
import { bhEditionRkey } from '../src/lib/server/bookhive/keys';
import { hasIsbn, mergeIsbnIdentifiers } from '../src/lib/server/isbn/merge';
import { editionRecordValueForCid } from '../src/lib/server/isbn/record-value';
import { rowIdentifiers } from '../src/lib/server/edition-record';
import { wireContributorsFor } from '../src/lib/server/jobs/wire-contributors';

interface Options {
  dry: boolean;
  pages: number;
  limit?: number;
}

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseArgs(argv: string[]): Options {
  const limitRaw = flagValue(argv, 'limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive number');
  }
  const pagesRaw = flagValue(argv, 'pages');
  const pages = pagesRaw === undefined ? Number.POSITIVE_INFINITY : Number(pagesRaw);
  if (!Number.isFinite(pages) && pagesRaw !== undefined) {
    throw new Error('--pages must be a positive number');
  }
  return { dry: argv.includes('--dry'), pages, limit };
}

/** ISBN strings a catalog record names, in merge order (ISBN-13 first). */
function isbnsFor(value: { isbn13?: string; isbn10?: string }): string[] {
  return [value.isbn13, value.isbn10].filter(
    (isbn): isbn is string => typeof isbn === 'string' && isbn.trim() !== '',
  );
}

async function run(): Promise<void> {
  const { dry, pages: maxPages, limit } = parseArgs(process.argv.slice(2));

  let cursor: string | undefined;
  let pages = 0;
  let seen = 0;
  let withIsbn = 0;
  let matched = 0;
  let written = 0;
  let already = 0;
  let failed = 0;

  for (;;) {
    const page = await fetchCatalogBooksPage({ cursor });
    pages++;
    seen += page.records.length;

    const isbnsByRkey = new Map<string, string[]>();
    for (const record of page.records) {
      const isbns = isbnsFor(record.value);
      if (isbns.length === 0) continue;
      withIsbn++;
      isbnsByRkey.set(bhEditionRkey(record.value.id), isbns);
    }

    if (isbnsByRkey.size > 0) {
      const rows = await db
        .select()
        .from(editions)
        .where(inArray(editions.rkey, [...isbnsByRkey.keys()]));
      matched += rows.length;

      for (const row of rows) {
        if (limit !== undefined && written >= limit) break;
        // Rows written before the identifier migration still hold the legacy
        // `{ uri, resource }` pair, so normalise instead of trusting the column.
        const identifiers = rowIdentifiers(row.identifiers);
        if (hasIsbn(identifiers)) {
          already++;
          continue;
        }
        const merged = mergeIsbnIdentifiers(identifiers, isbnsByRkey.get(row.rkey) ?? []);
        if (merged.added.length === 0) {
          already++;
          continue;
        }
        if (dry) {
          written++;
          console.log(`[backfill-bookhive-isbns] would write ${row.rkey} += ${merged.added.join(',')}`);
          continue;
        }
        // `defs#contributor` inlines names, so the stored strongRefs are
        // expanded exactly as the response boundary expands them before hashing.
        const contributors = await wireContributorsFor(db, row.contributors);
        const value = editionRecordValueForCid(row, merged.identifiers, contributors);
        if (!value) {
          failed++;
          continue;
        }
        const cid = (await cidForLex(value as unknown as LexMap)).toString();
        const updated = await db
          .update(editions)
          .set({ identifiers: merged.identifiers, cid, indexedAt: new Date() })
          .where(eq(editions.uri, row.uri))
          .returning({ uri: editions.uri });
        if (updated.length === 0) {
          failed++;
          continue;
        }
        written++;
      }
    }

    console.log(
      `[backfill-bookhive-isbns] pages=${pages} seen=${seen} with_isbn=${withIsbn} matched=${matched} written=${written} already=${already} failed=${failed}${dry ? ' (dry)' : ''}`,
    );

    if (limit !== undefined && written >= limit) break;
    if (!page.cursor || page.records.length === 0) break;
    if (pages >= maxPages) break;
    cursor = page.cursor;
  }

  console.log(
    `[backfill-bookhive-isbns] done pages=${pages} seen=${seen} with_isbn=${withIsbn} matched=${matched} written=${written} already=${already} failed=${failed}${dry ? ' (dry)' : ''}`,
  );
}

run().catch((err) => {
  console.error('[backfill-bookhive-isbns] failed', err);
  process.exit(1);
});
