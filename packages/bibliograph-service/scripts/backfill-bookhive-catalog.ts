#!/usr/bin/env tsx
// Fill `bh.*` editions from Bookhive's catalog: on-protocol ISBNs and, for
// editions imported before authors were resolved, contributor strongRefs.
//
// `buzz.bookhive.catalogBook` records carry `identifiers.isbn13` / `isbn10`
// (99% of the catalog has an identifiers object, ~82% an ISBN) and a free-form
// `authors` string. The edition mapping only ever emitted the bookhive and
// goodreads identifiers and dropped names it could not resolve, so the ISBN
// scan spent upstream searches on rows whose ISBN was already in hand and the
// matcher could not verify an author. This pass pages the catalog once and
// fixes both, recomputing the record CID from the same value the API serves.
//
//   node_modules/.bin/tsx scripts/backfill-bookhive-catalog.ts
//   pnpm tsx scripts/backfill-bookhive-catalog.ts --dry
//   pnpm tsx scripts/backfill-bookhive-catalog.ts --pages=5 --limit=500
//
// Idempotent: an edition that already has an ISBN / contributors is left alone,
// and a catalog record without them is a miss, not an error. Contributor ids
// are deterministic (`bh.a-<slug>`), so a re-run resolves the same rows.

import { eq, inArray } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import type { Logger } from 'pino';
import { db } from '../src/lib/server/db';
import { editions } from '../src/lib/server/db/schema';
import { fetchCatalogBooksPage, splitAuthors } from '../src/lib/server/bookhive/catalog';
import { bhEditionRkey } from '../src/lib/server/bookhive/keys';
import { prefetchContributors } from '../src/lib/server/api/contributor-name-resolver';
import { createLogger } from '../src/lib/server/logger';
import { mergeIsbnIdentifiers } from '../src/lib/server/isbn/merge';
import { editionRecordValueForCid } from '../src/lib/server/isbn/record-value';
import { wireContributorsFor } from '../src/lib/server/jobs/wire-contributors';
import type { ContributionEntry } from '../src/lib/server/search/types';

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

interface CatalogFields {
  isbns: string[];
  authors: string[];
}

async function run(): Promise<void> {
  const { dry, pages: maxPages, limit } = parseArgs(process.argv.slice(2));
  const log = createLogger('worker');

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

    const byRkey = new Map<string, CatalogFields>();
    for (const record of page.records) {
      const isbns = isbnsFor(record.value);
      if (isbns.length > 0) withIsbn++;
      byRkey.set(bhEditionRkey(record.value.id), {
        isbns,
        authors: splitAuthors(record.value.authors),
      });
    }

    if (byRkey.size > 0) {
      const rows = await db
        .select()
        .from(editions)
        .where(inArray(editions.rkey, [...byRkey.keys()]));
      matched += rows.length;

      // Every author this page could need, resolved in one pass: the row loop
      // below then reads the map instead of querying per edition.
      const resolver = await prefetchContributors(
        rows.flatMap((row) => (row.contributors.length === 0 ? byRkey.get(row.rkey)?.authors ?? [] : [])),
        'bookhive',
        log,
      );
      for (const row of rows) {
        if (limit !== undefined && written >= limit) break;
        const fields = byRkey.get(row.rkey);
        if (!fields) continue;

        const merged = mergeIsbnIdentifiers(row.identifiers, fields.isbns);
        const identifiersChanged = merged.added.length > 0;

        let contributors: ContributionEntry[] = row.contributors;
        let contributorsChanged = false;
        if (row.contributors.length === 0 && fields.authors.length > 0) {
          const resolved = await resolver.resolve(fields.authors);
          if (resolved.length > 0) {
            contributors = resolved;
            contributorsChanged = true;
          }
        }

        if (!identifiersChanged && !contributorsChanged) {
          already++;
          continue;
        }
        if (dry) {
          written++;
          const added = identifiersChanged ? merged.added.join(',') : '—';
          console.log(`[backfill-bookhive-catalog] would update ${row.rkey} isbn+=${added} contributors=${contributorsChanged}`);
          continue;
        }

        const wire = await wireContributorsFor(db, contributors);
        const value = editionRecordValueForCid(row, merged.identifiers, wire);
        if (!value) {
          failed++;
          continue;
        }
        const cid = (await cidForLex(value as unknown as LexMap)).toString();
        const updated = await db
          .update(editions)
          .set({
            identifiers: merged.identifiers,
            contributors,
            cid,
            indexedAt: new Date(),
          })
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
      `[backfill-bookhive-catalog] pages=${pages} seen=${seen} with_isbn=${withIsbn} matched=${matched} written=${written} already=${already} failed=${failed}${dry ? ' (dry)' : ''}`,
    );

    if (limit !== undefined && written >= limit) break;
    if (!page.cursor || page.records.length === 0) break;
    if (pages >= maxPages) break;
    cursor = page.cursor;
  }

  console.log(
    `[backfill-bookhive-catalog] done pages=${pages} seen=${seen} with_isbn=${withIsbn} matched=${matched} written=${written} already=${already} failed=${failed}${dry ? ' (dry)' : ''}`,
  );
}

run().catch((err: unknown) => {
  console.error('[backfill-bookhive-catalog] failed', err);
  process.exit(1);
});
